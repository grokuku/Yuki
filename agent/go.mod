// Module Go de l'« agent d'exécution » Yuki (Lot 4).
//
// ⚠️ Ce module est INDÉPENDANT du projet Node/TS de Yuki : il n'y a PAS de
// `go.mod` à la racine de Yuki. La version de l'agent (`agent/VERSION`) est
// découplée de la version de Yuki (`version.txt`).
//
// Dépendances : la bibliothèque standard couvre toute la cryptographie
// (crypto/hmac, crypto/sha256, crypto/hkdf, crypto/aes, crypto/cipher,
// crypto/ecdsa, crypto/x509), le transport WebSocket et l'exécution POSIX.
//
// ⚠️ UNE SEULE dépendance externe, **Windows uniquement** :
// `golang.org/x/sys` (licence BSD-3-Clause), importée sous `//go:build windows`
// pour le service Windows (`golang.org/x/sys/windows/svc`, `.../svc/mgr`) et le
// job object (`windows.CreateJobObject`…). Elle n'est PAS liée dans les
// binaires Linux (import conditionnel au build tag). Voir `docs/lot4.md`.
module github.com/grokuku/yuki/agent

go 1.27

require golang.org/x/sys v0.35.0
