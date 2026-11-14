/**
 * CONSIGNES DURABLES D'UN BOT — surface publique du module.
 *
 * Deux natures, deux listes, UN fichier Markdown par bot
 * (`<state>/bots/<id>/consignes.md`) :
 *  - `consignes` : instructions impératives (« ne refais plus jamais ça ») ;
 *  - `faits` : informations déclaratives (« mon NAS est à 10.0.0.5 »).
 *
 * ⚠️ Toujours injectées (blocs `<consignes>` / `<faits>`), jamais recherchées :
 * ce n'est PAS la mémoire.
 */

export {
  DOCUMENT_CONSIGNES_VIDE,
  ENTETE_FICHIER,
  MAX_CONSIGNES,
  MAX_ENTREE_CHARS,
  MAX_FAITS,
  MAX_INJECTION_CHARS,
  TITRE_CONSIGNES,
  TITRE_FAITS,
  ajouterEntree,
  analyserConsignes,
  ecrireTexteAtomique,
  listeDe,
  normaliserEntree,
  portConsignes,
  renduConsignes,
  retirerEntree,
  type AjoutConsigne,
  type CodeRefusConsignes,
  type ConsignesDocument,
  type LoggerConsignes,
  type NatureEntree,
  type OptionsPortConsignes,
  type PortConsignes,
  type RefusConsignes,
  type ResultatAjoutConsigne,
  type ResultatRemplacement,
  type ResultatRetraitConsigne,
  type RetraitConsigne,
} from "./consignes.js";

export {
  CONSIGNES_TAG,
  FAITS_TAG,
  blocsConsignes,
  insererConsignes,
  renduBlocs,
} from "./injection.js";
