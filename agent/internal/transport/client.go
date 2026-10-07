package transport

import (
	"context"
	"crypto/tls"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/grokuku/yuki/agent/internal/proto"
)

// DefaultPingInterval / DefaultOfflineAfter : heartbeat APPLICATIF acté pour
// l'agent (ping/pong toutes les 15 s ; hors ligne après 45 s sans pong).
const (
	DefaultPingInterval = 15 * time.Second
	DefaultOfflineAfter = 45 * time.Second
)

// ReplyFunc permet à un gestionnaire de renvoyer une trame à Yuki (accusé,
// résultat, erreur). Sûr en accès concurrent.
type ReplyFunc func(proto.Message) error

// Handler traite les trames APPLICATIVES reçues de Yuki.
//
// ⚠️ Le gestionnaire ne décide de RIEN : il exécute/accuse selon la trame. Le
// niveau de garde-fou et l'autorité restent dans Yuki (D118/D126).
type Handler interface {
	HandleMessage(ctx context.Context, msg proto.Message, reply ReplyFunc) error
}

// HandlerFunc adapte une fonction en `Handler`.
type HandlerFunc func(ctx context.Context, msg proto.Message, reply ReplyFunc) error

// HandleMessage implémente `Handler`.
func (f HandlerFunc) HandleMessage(ctx context.Context, msg proto.Message, reply ReplyFunc) error {
	return f(ctx, msg, reply)
}

// Logger est le journal minimal de l'agent (style Yuki : message + champs).
type Logger interface {
	Debug(message string, fields map[string]any)
	Info(message string, fields map[string]any)
	Warn(message string, fields map[string]any)
	Error(message string, fields map[string]any)
}

// NopLogger ignore tout (utile aux tests et aux usages silencieux).
type NopLogger struct{}

// Debug n'écrit rien.
func (NopLogger) Debug(string, map[string]any) {}

// Info n'écrit rien.
func (NopLogger) Info(string, map[string]any) {}

// Warn n'écrit rien.
func (NopLogger) Warn(string, map[string]any) {}

// Error n'écrit rien.
func (NopLogger) Error(string, map[string]any) {}

// Options règle le client de transport.
type Options struct {
	// URL : `wss://<hôte>:<port>/ws` (chemin `AGENTS_WS_PATH` côté Yuki).
	URL string
	// TLSConfig : mTLS (cert client d'appairage + CA épinglé).
	TLSConfig *tls.Config
	// Hello : trame de présentation envoyée à CHAQUE connexion (facultative).
	Hello *proto.Hello
	// Handler : traite les trames entrantes. Obligatoire.
	Handler Handler
	// Logger : journal (défaut `NopLogger`).
	Logger Logger

	// BaseDelay / MaxDelay / Jitter : backoff de reconnexion.
	BaseDelay time.Duration
	MaxDelay  time.Duration
	Jitter    float64
	// PingInterval / OfflineAfter : heartbeat applicatif.
	PingInterval time.Duration
	OfflineAfter time.Duration
	// DialTimeout / WriteTimeout : bornes réseau.
	DialTimeout  time.Duration
	WriteTimeout time.Duration
	// DedupeLimit : taille du MRU d'idempotence (défaut 1024).
	DedupeLimit int

	// Rand : source uniforme pour le jitter (tests). Nil ⇒ aléa global.
	Rand func() float64
	// Now : horloge injectable (tests).
	Now func() time.Time
	// OnConnect : rappel après l'envoi du `hello` (observabilité/tests).
	OnConnect func(conn *Conn)
}

func (o Options) withDefaults() Options {
	if o.Logger == nil {
		o.Logger = NopLogger{}
	}
	if o.BaseDelay <= 0 {
		o.BaseDelay = DefaultBaseDelay
	}
	if o.MaxDelay <= 0 {
		o.MaxDelay = DefaultMaxDelay
	}
	if o.Jitter == 0 {
		o.Jitter = DefaultJitter
	}
	if o.PingInterval <= 0 {
		o.PingInterval = DefaultPingInterval
	}
	if o.OfflineAfter <= 0 {
		o.OfflineAfter = DefaultOfflineAfter
	}
	if o.DialTimeout <= 0 {
		o.DialTimeout = 10 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 10 * time.Second
	}
	if o.DedupeLimit <= 0 {
		o.DedupeLimit = DefaultDedupeLimit
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// Client est la boucle de transport permanente de l'agent : elle se connecte,
// se présente, bat le cœur, traite les trames, et se reconnecte indéfiniment.
type Client struct {
	opts     Options
	backoff  *Backoff
	mru      *MRU
	lastPong atomic.Int64
}

// NewClient valide les options et construit le client.
func NewClient(opts Options) (*Client, error) {
	opts = opts.withDefaults()
	if opts.URL == "" {
		return nil, fmt.Errorf("transport : URL requise")
	}
	if opts.Handler == nil {
		return nil, fmt.Errorf("transport : Handler requis")
	}
	if opts.OfflineAfter < opts.PingInterval {
		return nil, fmt.Errorf("transport : OfflineAfter (%s) doit être ≥ PingInterval (%s)",
			opts.OfflineAfter, opts.PingInterval)
	}
	client := &Client{
		opts:    opts,
		backoff: NewBackoff(opts.BaseDelay, opts.MaxDelay, opts.Jitter),
		mru:     NewMRU(opts.DedupeLimit),
	}
	// Le jitter du backoff utilise la source injectée (tests déterministes).
	client.backoff.Rand = opts.Rand
	return client, nil
}

// Run boucle jusqu'à l'annulation de `ctx`. Elle ne renvoie jamais d'erreur
// « fatale » : un échec de connexion est suivi d'une reconnexion (sauf
// annulation). Renvoie `ctx.Err()` à l'arrêt.
func (c *Client) Run(ctx context.Context) error {
	c.opts.Logger.Info("agent.transport.demarrage", map[string]any{"url": c.opts.URL})
	for {
		if err := ctx.Err(); err != nil {
			c.opts.Logger.Info("agent.transport.arret", nil)
			return err
		}
		conn, err := c.dial(ctx)
		if err != nil {
			c.logReconnect(err)
			if !c.sleep(ctx) {
				return ctx.Err()
			}
			continue
		}
		// Connexion établie : le backoff repart de la base.
		c.backoff.Reset()
		err = c.serve(ctx, conn)
		_ = conn.Close()
		if ctx.Err() != nil {
			c.opts.Logger.Info("agent.transport.arret", nil)
			return ctx.Err()
		}
		c.logReconnect(err)
		if !c.sleep(ctx) {
			return ctx.Err()
		}
	}
}

// sleep attend le prochain délai du backoff, ou s'interrompt à l'annulation.
// Renvoie `false` si `ctx` a été annulé.
func (c *Client) sleep(ctx context.Context) bool {
	delay := c.backoff.Next()
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (c *Client) logReconnect(err error) {
	c.opts.Logger.Warn("agent.transport.deconnecte", map[string]any{
		"error": errString(err),
	})
}

// dial ouvre la connexion WebSocket avec le délai d'établissement configuré.
func (c *Client) dial(ctx context.Context) (*Conn, error) {
	dialCtx, cancel := context.WithTimeout(ctx, c.opts.DialTimeout)
	defer cancel()
	return Dial(dialCtx, c.opts.URL, DialOptions{
		TLSConfig:        c.opts.TLSConfig,
		HandshakeTimeout: c.opts.DialTimeout,
		WriteTimeout:     c.opts.WriteTimeout,
	})
}

// serve joue UNE session : présentation, heartbeat, boucle de lecture.
func (c *Client) serve(parent context.Context, conn *Conn) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	c.lastPong.Store(c.opts.Now().UnixNano())
	conn.OnPong = func() { c.lastPong.Store(c.opts.Now().UnixNano()) }

	// Annulation du parent ⇒ on ferme la connexion pour débloquer la lecture.
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	if c.opts.Hello != nil {
		data, err := proto.Encode(c.opts.Hello)
		if err != nil {
			return err
		}
		if err := conn.WriteText(ctx, data); err != nil {
			return err
		}
	}
	c.opts.Logger.Info("agent.transport.connecte", map[string]any{
		"remote": conn.RemoteAddr().String(),
	})
	if c.opts.OnConnect != nil {
		c.opts.OnConnect(conn)
	}

	go c.heartbeat(ctx, conn)

	for {
		_ = conn.SetReadDeadline(c.opts.Now().Add(c.opts.OfflineAfter))
		opcode, payload, err := conn.ReadMessage(ctx)
		if err != nil {
			return err
		}
		if opcode != opText {
			continue
		}
		msg, err := proto.Decode(payload)
		if err != nil {
			// Trame illisible ou type inconnu (ex. `welcome` d'une version
			// antérieure du serveur) : on la JOURNALISE et on l'IGNORE, sans
			// couper la connexion.
			c.opts.Logger.Warn("agent.transport.trame_ignoree", map[string]any{
				"error": errString(err),
			})
			continue
		}
		c.dispatch(ctx, conn, msg)
	}
}

// dispatch traite une trame décodée, en appliquant l'idempotence sur les
// commandes (rejeu ignoré).
func (c *Client) dispatch(ctx context.Context, conn *Conn, msg proto.Message) {
	if _, ok := msg.(*proto.Pong); ok {
		c.lastPong.Store(c.opts.Now().UnixNano())
		return
	}
	if cmd, ok := msg.(*proto.Cmd); ok {
		if c.mru.Observe(cmd.CmdID) {
			c.opts.Logger.Warn("agent.transport.rejeu_ignore", map[string]any{
				"cmd_id": cmd.CmdID,
			})
			return
		}
	}
	reply := func(m proto.Message) error {
		data, err := proto.Encode(m)
		if err != nil {
			return err
		}
		return conn.WriteText(ctx, data)
	}
	if err := c.opts.Handler.HandleMessage(ctx, msg, reply); err != nil {
		c.opts.Logger.Error("agent.transport.traitement_echec", map[string]any{
			"type":  string(msg.Type()),
			"error": errString(err),
		})
	}
}

// heartbeat émet un ping applicatif toutes les `PingInterval` et déclare la
// connexion HORS LIGNE si aucun pong n'a été vu depuis `OfflineAfter`.
func (c *Client) heartbeat(ctx context.Context, conn *Conn) {
	ticker := time.NewTicker(c.opts.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			last := time.Unix(0, c.lastPong.Load())
			if c.opts.Now().Sub(last) > c.opts.OfflineAfter {
				c.opts.Logger.Warn("agent.transport.hors_ligne", map[string]any{
					"depuis_ms": c.opts.Now().Sub(last).Milliseconds(),
				})
				_ = conn.Close()
				return
			}
			ping := &proto.Ping{T: c.opts.Now().UnixMilli()}
			data, err := proto.Encode(ping)
			if err != nil {
				continue
			}
			if err := conn.WriteText(ctx, data); err != nil {
				c.opts.Logger.Warn("agent.transport.ping_echec", map[string]any{
					"error": errString(err),
				})
				_ = conn.Close()
				return
			}
		}
	}
}

// Seen indique si un identifiant de commande a déjà été traité (idempotence).
func (c *Client) Seen(cmdID string) bool { return c.mru.Contains(cmdID) }

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
