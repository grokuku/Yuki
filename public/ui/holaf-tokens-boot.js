/**
 * Neutralisation du marqueur `<style>` de la brique holaf-tokens — CSP.
 *
 * La brique `tokens` (holaf-tokens 0.3.0) injecte AU CHARGEMENT un `<style>`
 * SANS aucune règle (simple marqueur documentaire), via `ensureCss()`. Or Yuki
 * sert ses pages avec une CSP stricte `style-src 'self'` (SANS `unsafe-inline`) :
 * tout `<style>` sans nonce déclenche une violation (« Applying inline style
 * violates… ») — et l'architecture Yuki n'injecte AUCUN `<style>`.
 *
 * La brique est IDEMPOTENTE : `ensureCss()` commence par
 *   `if (document.getElementById("holaf-tokens-style")) return;`
 * En posant D'AVANCE un élément inerte (un `<meta>`) portant cet id, la brique
 * ne crée donc aucun `<style>` : zéro violation CSP, zéro style injecté.
 *
 * ⚠️ L'ORDRE D'ÉVALUATION EST CAPITAL : ce module doit être ÉVALUÉ avant
 * `vendor/holaf/holaf-tokens.js`. C'est garanti par l'ordre des `import` de
 * `theme.js` (les dépendances d'un module ES sont évaluées dans l'ordre, en
 * profondeur d'abord) : ce fichier est importé EN PREMIER.
 *
 * Le `<meta>` est inerte (aucun rendu, aucune règle, aucune couleur) ; il ne
 * sert qu'à satisfaire le garde de la brique. Rien d'autre n'est modifié.
 */

if (typeof document !== "undefined" && !document.getElementById("holaf-tokens-style")) {
  const marker = document.createElement("meta");
  marker.id = "holaf-tokens-style";
  document.head.appendChild(marker);
}
