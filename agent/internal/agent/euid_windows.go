//go:build windows

package agent

// effectiveUID : Windows n'a pas d'UID POSIX ; l'agent déclare `-1` et c'est le
// compte de service configuré qui porte le privilège (D120).
func effectiveUID() int { return -1 }
