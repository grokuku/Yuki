/**
 * CATALOGUE DES CHAMPS DE CONFIGURATION (lot 35d, sous-lot 1b-4) — module PUR,
 * sans DOM : testable sans navigateur, importé par `config.js`.
 *
 * Ce fichier ne contient QUE des données : les groupes de champs affichés, leurs
 * options, leurs libellés et le miroir des valeurs par défaut. Il ne décide PAS
 * de ce qui est rendu : chaque groupe déclare les ONGLETS où il apparaît sur
 * chacune des deux pages (`tabs: { instance, bot }`), et la PORTÉE de chaque clé
 * (`scope` du schéma, servie par le serveur) décide champ par champ — voir
 * `config-pages.js`.
 *
 * ⚠️ `tabs` n'est pas une liste d'onglets « par défaut » : un groupe dont
 * `tabs.bot` est absent n'a AUCUN champ de portée `bot`, il n'apparaît donc
 * jamais sur la page Bot. L'absence est vérifiée par les tests
 * (`tests/ui/config-pages.test.ts`), qui croisent ce catalogue avec
 * `CONFIG_SCHEMA`.
 */

import { MODELE_DISCUSSION_INTRO } from './modeles-aide.js';

export const OPTIONS = {
  api: [["openai-completions", "openai-completions"]],
  thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => [v, v]),
  profiles: [
    ["", "∅ (auto)"],
    ["confort", "confort"],
    ["compact", "compact"],
    ["repli", "repli"],
    ["texte-seul", "texte-seul"],
  ],
  compat: [
    ["strict", "strict"],
    ["auto-degrade", "auto-degrade"],
  ],
  missingKey: [
    ["degrade", "degrade"],
    ["refuse", "refuse"],
  ],
  // ⚠️ CAPACITÉ VISION : une DÉCLARATION, pas une mesure. Aucune API ne publie
  // « ce modèle voit les images » : c'est à l'utilisateur de le dire, et ce
  // réglage produit `input` dans `models.json`. « non » ⇒ les images ne sont pas
  // envoyées au modèle (et le résultat d'un outil le DIT, jamais de silence).
  vision: [
    ["oui", "oui — le modèle voit les images"],
    ["non", "non — pas d'image envoyée au modèle"],
  ],
  // Lot 7 — TTS / voix.
  ttsEnabled: [
    ["off", "désactivé"],
    ["on", "activé"],
  ],
  ttsEngine: [
    ["chatterbox", "chatterbox"],
    ["qwen3-tts", "qwen3-tts"],
    ["cosyvoice3", "cosyvoice3"],
    ["kokoro", "kokoro"],
    ["sanotts", "sanotts"],
  ],
  ttsLanguage: [["fr", "français (fr)"]],
  ttsEmotion: [
    ["neutre", "neutre"],
    ["expressive", "expressive"],
    ["dramatique", "dramatique"],
    ["personnalisee", "personnalisée"],
  ],
  // Notifications (PWA + Web Push).
  pushEnabled: [
    ["on", "activées"],
    ["off", "désactivées"],
  ],
};

export const GROUPS = [
  {
    id: "llm-light",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "modeles" },
    title: "Modèle de discussion",
    role: "light",
    // ⚠️ Texte d'AIDE de l'onglet, pas un libellé de clé : il n'explique que
    // la RÉPARTITION des rôles. Une phrase, sous le titre du premier groupe.
    intro: MODELE_DISCUSSION_INTRO,
    fields: [
      { path: "llm.light.baseUrl", label: "URL de base", kind: "text" },
      { path: "llm.light.apiKey", label: "Clé d'API", kind: "secret" },
      { path: "llm.light.model", label: "Modèle", kind: "text" },
      {
        path: "llm.light.vision",
        label: "Reçoit les images (vision)",
        kind: "select",
        options: OPTIONS.vision,
        helper:
          "Déclaration, pas une mesure : aucun fournisseur ne publie si un modèle " +
          "voit les images. « non » ⇒ Yuki n'envoie AUCUNE image à ce modèle " +
          "(pièces jointes comme captures) ; « oui » ⇒ les images partent en pièce " +
          "jointe. Appliqué à chaud.",
      },
      { path: "llm.light.api", label: "Dialecte d'API", kind: "select", options: OPTIONS.api },
      { path: "llm.light.thinking", label: "Réflexion (thinking)", kind: "select", options: OPTIONS.thinking },
    ],
  },
  {
    id: "llm-heavy",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "modeles" },
    title: "Modèle de travail",
    role: "heavy",
    fields: [
      { path: "llm.heavy.baseUrl", label: "URL de base", kind: "text" },
      { path: "llm.heavy.apiKey", label: "Clé d'API", kind: "secret" },
      { path: "llm.heavy.model", label: "Modèle", kind: "text" },
      {
        path: "llm.heavy.vision",
        label: "Reçoit les images (vision)",
        kind: "select",
        options: OPTIONS.vision,
        helper:
          "Déclaration, pas une mesure : aucun fournisseur ne publie si un modèle " +
          "voit les images. « oui » ⇒ une image récupérée d'une machine " +
          "(`recuperer_fichier`) est jointe au worker ; « non » ⇒ elle n'est PAS " +
          "envoyée et le résultat de l'outil le dit. Appliqué à chaud (job suivant).",
      },
      { path: "llm.heavy.api", label: "Dialecte d'API", kind: "select", options: OPTIONS.api },
      { path: "llm.heavy.thinking", label: "Réflexion (thinking)", kind: "select", options: OPTIONS.thinking },
    ],
  },
  {
    id: "delegation",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "execution" },
    title: "Délégation",
    fields: [
      { path: "llm.missingKeyMode", label: "Politique si clé manquante", kind: "select", options: OPTIONS.missingKey },
      { path: "delegation.defaultDeadlineMs", label: "Attente inline par défaut (ms)", kind: "number", min: 200, max: 60000 },
      { path: "delegation.maxConcurrent", label: "Jobs simultanés", kind: "number", min: 1 },
      { path: "delegation.maxQueue", label: "Taille de la file", kind: "number", min: 0 },
      { path: "delegation.idleTimeoutMs", label: "Timeout d'inactivité (ms)", kind: "number", min: 1 },
      // ⚠️ Doit RESTER au-dessus du plafond de génération d'image (`images.timeoutMs`,
      // 1 h par défaut) + la rédaction et la publication du rapport : un job coupé
      // ici serait coupé par une limite plus LARGE que la génération, sans explication.
      {
        path: "delegation.totalTimeoutMs",
        label: "Durée maximale d'un job (ms)",
        kind: "number",
        min: 1,
        helper:
          "Durée maximale d'un travail délégué, rédaction et publication du " +
          "rapport comprises. Défaut 4 500 000 ms (75 minutes) : elle doit " +
          "rester au-dessus du plafond d'une génération (onglet Images) et de " +
          "la rédaction. Appliquée au redémarrage.",
      },
    ],
  },
  {
    id: "gpu",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme" },
    title: "GPU",
    fields: [
      { path: "gpu.profile", label: "Profil forcé", kind: "select", options: OPTIONS.profiles },
      { path: "gpu.compatMode", label: "Mode de compatibilité", kind: "select", options: OPTIONS.compat },
      { path: "gpu.minDriver", label: "Driver NVIDIA minimal (majeure)", kind: "number", min: 1 },
    ],
  },
  {
    id: "notifications",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme", bot: "general" },
    // ⚠️ ENCART DE RENVOI : la notification d'un bot se règle sur SA page.
    renvoi: {
      instance: {
        texte:
          "Un bot peut couper SES notifications (le côté bot de « Activer les " +
          "notifications ») :",
        lien: { href: "/bots#general", libelle: "Bot · Général" },
      },
      bot: {
        texte:
          "Le contact VAPID et l'interrupteur GLOBAL du serveur restent communs :",
        lien: { href: "/config#systeme", libelle: "Configuration · Système" },
      },
    },
    title: "Notifications (appareils)",
    fields: [
      {
        path: "push.enabled",
        label: "Activer les notifications",
        kind: "select",
        options: OPTIONS.pushEnabled,
        helper:
          "Interrupteur GLOBAL du serveur. Chaque appareil s'abonne séparément depuis le bouton « Notifications » de la barre du haut (chat) : accepter la permission du navigateur EST l'opt-in. Désactiver ici coupe les envois pour TOUS les appareils.",
      },
      {
        path: "push.contact",
        label: "Contact VAPID (mailto: ou URL)",
        kind: "text",
        helper:
          "Sujet (sub) du JWT VAPID, exigé par certains services de push. Une adresse de contact suffit ; elle n'est pas vérifiée.",
      },
    ],
  },
  {
    id: "prompts",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "modeles", bot: "personnalite" },
    // ⚠️ ENCART DE RENVOI : une clé `mixte` a une valeur COMMUNE (ici) et une
    // surcharge PAR BOT (page Bot · Personnalité). Le dire évite de croire que
    // régler un prompt ici écrase la surcharge d'un bot.
    renvoi: {
      instance: {
        texte:
          "Ces prompts sont la valeur COMMUNE. Chaque bot peut les surcharger " +
          "depuis sa page :",
        lien: { href: "/bots#personnalite", libelle: "Bot · Personnalité" },
      },
      bot: {
        texte:
          "La valeur COMMUNE (celle qui s'applique sans surcharge) se règle sur :",
        lien: { href: "/config#modeles", libelle: "Configuration · Modèles" },
      },
    },
    title: "Prompts système",
    // Bloc LECTURE SEULE : l'instruction vocale réellement injectée (volet 1).
    voiceInstruction: true,
    // ⚠️ DIT explicitement ce qui n'est PAS réglable ici : sans cette phrase,
    // l'utilisateur cherche à régler aussi le prompt des réponses publiées dans
    // un canal (Mattermost / Discord) et croit qu'il a été ignoré.
    note:
      "Ces deux prompts sont ceux du chat LOCAL (et du worker lourd). Le prompt des réponses PUBLIÉES DANS UN CANAL (Mattermost, Discord) n'est PAS réglable ici : c'est une constante du code (src/chat/reply/prompt.ts), pour que le mode « auto » reste borné.",
    fields: [
      {
        path: "prompts.light",
        label: "Prompt système — léger",
        kind: "textarea",
        helper:
          "Un champ vide est REFUSÉ : sans consigne, le modèle n'a plus de cadre. « Réinitialiser au défaut » réécrit le prompt LIVRÉ (config/pi/system-prompt.md).",
      },
      {
        path: "prompts.heavy",
        label: "Prompt système — lourd",
        kind: "textarea",
        helper:
          "Utilisé par le worker lourd (tâche déléguée). Un champ vide est REFUSÉ ; « Réinitialiser au défaut » réécrit le prompt LIVRÉ (config/pi/system-prompt-heavy.md).",
      },
    ],
  },
  {
    id: "memoire",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme", bot: "memoire" },
    // ⚠️ ENCART DE RENVOI : la mémoire d'un bot se règle sur SA page ; sa
    // PLANIFICATION de consolidation, elle, reste commune (instance).
    renvoi: {
      instance: {
        texte:
          "Les réglages de la mémoire durable (rappel, extraction, mise de côté) " +
          "sont propres à chaque bot :",
        lien: { href: "/bots#memoire", libelle: "Bot · Mémoire" },
      },
      bot: {
        texte:
          "La PLANIFICATION de la consolidation (cron, fuseau, budget, versions " +
          "conservées) est commune à l'instance :",
        lien: { href: "/config#systeme", libelle: "Configuration · Système" },
      },
    },
    title: "Mémoire durable",
    fields: [
      {
        path: "memory.enabled",
        label: "Activer la mémoire",
        kind: "select",
        options: [
          ["on", "activée"],
          ["off", "désactivée"],
        ],
        helper:
          "Yuki retient automatiquement vos préférences et faits durables, et les rappelle avant chaque réponse. Aucun bouton : tout est automatique.",
      },
      {
        path: "memory.recall.topK",
        label: "Souvenirs rappelés (top-k)",
        kind: "number",
        min: 0,
        max: 20,
        helper:
          "Nombre maximal de souvenirs pertinents injectés avant une réponse. Petit par construction (coût sur le temps de première réponse).",
      },
      {
        path: "memory.recall.budgetChars",
        label: "Budget de rappel (caractères)",
        kind: "number",
        min: 0,
        max: 40000,
        advanced: true,
        helper: "Taille maximale du bloc de souvenirs injecté (0 = aucun rappel).",
      },
      {
        path: "memory.recall.timeoutMs",
        label: "Délai maximal du rappel (ms)",
        kind: "number",
        min: 20,
        max: 5000,
        advanced: true,
        helper:
          "Au-delà, la réponse part SANS mémoire (dégradation gracieuse). N'allonge jamais l'attente.",
      },
      {
        path: "memory.extract.maxItems",
        label: "Souvenirs extraits par tour",
        kind: "number",
        min: 0,
        max: 10,
        advanced: true,
        helper:
          "Nombre maximal de souvenirs durables extraits d'un échange (0 = écriture désactivée).",
      },
      {
        path: "memory.extract.timeoutMs",
        label: "Délai maximal d'extraction (ms)",
        kind: "number",
        min: 1000,
        max: 300000,
        advanced: true,
        helper: "Hors chemin de réponse : n'affecte jamais le temps de réponse visible.",
      },
      // ⚠️ LOT 35i : les deux bornes de la passe de MISE DE CÔTÉ manquaient à cet
      // onglet (clés `bot` du schéma, réglables nulle part). Ce sont elles qui
      // bornent la relecture d'une conversation mise de côté.
      {
        path: "memory.setAside.maxChars",
        label: "Mise de côté — taille relue (caractères)",
        kind: "number",
        min: 1000,
        max: 120000,
        advanced: true,
        helper:
          "Une conversation mise de côté est RELUE EN ENTIER pour en extraire des souvenirs : ce plafond borne la taille d'un appel (découpé au-delà).",
      },
      {
        path: "memory.setAside.maxChunks",
        label: "Mise de côté — nombre d'appels",
        kind: "number",
        min: 1,
        max: 6,
        advanced: true,
        helper:
          "Nombre maximal d'appels au modèle pour relire une conversation mise de côté (une longue conversation coûte plusieurs appels, jamais un nombre illimité).",
      },
      {
        path: "memory.consolidation.enabled",
        label: "Consolidation hebdomadaire",
        kind: "select",
        options: [
          ["on", "activée"],
          ["off", "désactivée"],
        ],
        helper:
          "Une passe relit TOUTE la mémoire avec le modèle LOURD : elle fusionne les doublons, corrige et " +
          "supprime ce qui est transitoire. Chaque passe est archivée (versions restaurables ci-dessous).",
      },
      {
        path: "memory.consolidation.cron",
        label: "Quand (expression cron)",
        kind: "text",
        advanced: true,
        helper:
          "5 champs « minute heure jour-du-mois mois jour-de-semaine ». Défaut « 0 3 * * 0 » = dimanche " +
          "03:00 dans le fuseau ci-dessous. Un passage manqué est rattrapé UNE fois s'il a moins de 24 h.",
      },
      {
        path: "memory.consolidation.timeZone",
        label: "Fuseau de la planification",
        kind: "text",
        advanced: true,
        helper:
          "Fuseau IANA de l'heure de la passe (défaut Europe/Paris = « 3 h du matin à Paris »). " +
          "⚠️ Distinct du fuseau d'AFFICHAGE des horodatages, qui reste UTC.",
      },
      {
        path: "memory.consolidation.budgetTokens",
        label: "Budget de tokens par passe",
        kind: "number",
        min: 1000,
        max: 2000000,
        advanced: true,
        helper:
          "Plafond du volume envoyé au modèle. Il ne dépasse jamais le contexte réel du modèle lourd. " +
          "Si toute la mémoire tient dedans, elle est traitée en UN SEUL lot.",
      },
      {
        path: "memory.consolidation.retention",
        label: "Versions conservées",
        kind: "number",
        min: 1,
        max: 100,
        advanced: true,
        helper:
          "Nombre d'archives de consolidation gardées (12 ≈ 3 mois). Au-delà, la plus ancienne est purgée " +
          "et la purge est journalisée.",
      },
    ],
  },
  {
    id: "tts",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme", bot: "voix" },
    // ⚠️ ENCART DE RENVOI (④) : depuis la scission, la voix d'un bot et le
    // MOTEUR ne sont plus sur la même page. Sans cet encart, on cherche le
    // moteur dans « Voix » (où il était) et on ne le trouve pas.
    renvoi: {
      instance: {
        texte:
          "La voix d'un bot (voix active, émotion, débit, exagération, guidage) " +
          "se règle sur SA page :",
        lien: { href: "/bots#voix", libelle: "Bot · Voix" },
      },
      bot: {
        texte:
          "Le MOTEUR, la langue, la découpe et les délais de synthèse restent " +
          "communs à l'instance :",
        lien: { href: "/config#systeme", libelle: "Configuration · Système" },
      },
    },
    title: "Réglages de la voix",
    fields: [
      // — Zone ③ : les 6 réglages ESSENTIELS (visibles sans clic) —
      {
        path: "tts.enabled",
        label: "Activer la voix",
        kind: "select",
        options: OPTIONS.ttsEnabled,
        helper: "Active la synthèse vocale. Prise en compte après un redémarrage de Yuki.",
      },
      {
        path: "tts.engine",
        label: "Moteur de synthèse",
        kind: "select",
        options: OPTIONS.ttsEngine,
        helper: "Moteur qui prononce le texte. Certains réglages ne s'appliquent qu'à certains moteurs.",
      },
      {
        path: "tts.language",
        label: "Langue",
        kind: "select",
        options: OPTIONS.ttsLanguage,
        helper: "Langue de la voix.",
      },
      {
        path: "tts.emotion",
        label: "Émotion",
        kind: "select",
        options: OPTIONS.ttsEmotion,
        helper: "Intonation générale. « personnalisée » active les curseurs d'exagération et de guidage (zone « Avancé »).",
      },
      {
        path: "tts.speed",
        label: "Débit de parole (%)",
        kind: "number",
        min: 50,
        max: 200,
        helper: "Vitesse de la parole en pourcentage (100 = normal).",
      },
      {
        path: "tts.volume",
        label: "Volume de lecture (%)",
        kind: "number",
        min: 0,
        max: 100,
        helper: "Volume de lecture côté navigateur (100 = maximum).",
      },
      // ⚠️ `tts.voice` n'est PLUS un champ texte ici : la bibliothèque de voix
      // (zone ②, `voices-panel.js`) en est l'unique contrôle et l'écrit tout de suite.
      // — Zone ④ : le technique, replié sous « Avancé » —
      {
        path: "tts.baseUrl",
        label: "Adresse du moteur (avancé)",
        kind: "text",
        advanced: true,
        helper: "Adresse du service TTS dans le réseau Docker. À ne changer que si vous relocalisez le moteur.",
      },
      {
        path: "tts.exaggeration",
        label: "Exagération (pour-mille)",
        kind: "range",
        min: 0,
        max: 1500,
        step: 10,
        advanced: true,
        revealWhen: { path: "tts.emotion", equals: "personnalisee" },
        helper: "Force d'expression (500 = neutre). N'agit qu'avec une émotion « personnalisée » et un moteur compatible.",
      },
      {
        path: "tts.cfg",
        label: "Contrôle de guidage (CFG)",
        kind: "range",
        min: 0,
        max: 1500,
        step: 10,
        advanced: true,
        revealWhen: { path: "tts.emotion", equals: "personnalisee" },
        helper: "Fidélité au style demandé (500 = neutre). N'agit qu'avec une émotion « personnalisée » et un moteur compatible.",
      },
      {
        path: "tts.prefetchDepth",
        label: "Préchargement (phrases d'avance)",
        kind: "number",
        min: 0,
        max: 2,
        advanced: true,
        helper: "Nombre de phrases synthétisées à l'avance pour réduire l'attente entre les phrases.",
      },
      {
        path: "tts.minSentenceChars",
        label: "Découpe — longueur minimale d'une phrase",
        kind: "number",
        min: 8,
        max: 500,
        advanced: true,
        helper: "En deçà, un fragment n'est pas découpé seul.",
      },
      {
        path: "tts.maxSentenceChars",
        label: "Découpe — longueur maximale d'une phrase",
        kind: "number",
        min: 40,
        max: 2000,
        advanced: true,
        helper: "Au-delà, la phrase est coupée pour être synthétisée par morceaux.",
      },
      {
        path: "tts.timeoutMs",
        label: "Délai maximal de synthèse (ms)",
        kind: "number",
        min: 1000,
        max: 120000,
        advanced: true,
        helper: "Au-delà, la synthèse est abandonnée (le moteur est peut-être bloqué).",
      },
    ],
  },
  {
    id: "transport",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme" },
    title: "Transport temps réel",
    fields: [
      { path: "transport.replayBuffer", label: "Buffer de rejeu (trames)", kind: "number", min: 1 },
      { path: "transport.replayBytes", label: "Buffer de rejeu (octets)", kind: "number", min: 1 },
    ],
  },
  {
    id: "affichage",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme" },
    title: "Affichage — fuseau des horodatages",
    fields: [
      {
        path: "ui.timeZone",
        label: "Fuseau horaire des horodatages",
        kind: "text",
        helper:
          "Fuseau IANA utilisé pour TOUS les horodatages : les repères des prompts " +
          "(« [horodatage] … (UTC) »), les heures du fil de canal, l'interface et le " +
          "journal. Défaut « UTC » — c'est le fuseau de Mattermost, donc les deux " +
          "affichent la MÊME heure pour un même message. Exemples : UTC, " +
          "Europe/Paris, America/New_York. ⚠️ Un nom inconnu est REFUSÉ (il ferait " +
          "afficher une heure fausse sans le dire). ⚠️ La PLANIFICATION n'est pas " +
          "concernée : un déclencheur « tous les jours à 9 h » tire à 9 h dans SON " +
          "fuseau, et un envoi programmé dans celui de l'envoi. Appliqué à chaud.",
      },
    ],
  },
  {
    id: "agents-acces",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "agents" },
    title: "Accès des agents",
    fields: [
      {
        path: "agents.serverName",
        label: "Adresse ou nom que vos agents utilisent",
        kind: "text",
        helper:
          "Adresse ou nom que vos agents utilisent pour joindre Yuki " +
          "(ex. 10.10.0.5 ou yuki.lan). Cette valeur est inscrite dans le " +
          "certificat serveur de Yuki, sinon vos agents ne peuvent pas vérifier " +
          "le certificat par l'adresse réseau. Plusieurs valeurs possibles, " +
          "séparées par des virgules. ⚠️ Yuki tourne dans un conteneur : elle ne " +
          "peut pas deviner l'adresse de l'hôte, il faut la déclarer ici. " +
          "Modification appliquée à chaud (certificat régénéré sans redémarrage).",
      },
    ],
  },
  {
    id: "librarian",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme" },
    title: "Libraire (recherche documentaire et web)",
    // Bouton « Tester la connexion » dédié (route `POST /api/config/librarian/test`).
    test: "librarian",
    fields: [
      {
        path: "librarian.baseUrl",
        label: "URL de base du libraire",
        kind: "text",
        helper:
          "Adresse de Libry, selon votre réseau : même réseau Docker " +
          "(http://pi-web:3000), même machine (http://<ip>:3005), ou accès public " +
          "(https://pi.holaf.fr). ⚠️ Vide = libraire non configuré : les outils " +
          "ne sont alors pas proposés au modèle. Renseigner l'URL prend effet au " +
          "prochain redémarrage (l'URL elle-même est ensuite modifiable à chaud).",
      },
      {
        path: "librarian.apiKey",
        label: "Clé libraire (recommandée)",
        kind: "secret",
        helper:
          "⚠️ SEUL champ requis pour l'authentification auprès de Libry. Secret " +
          "« lib-… » envoyé dans l'en-tête X-API-Key (et/ou Authorization). " +
          "Jamais réaffiché en clair.",
      },
      {
        path: "librarian.screenshot",
        label: "Capture de pages web",
        kind: "select",
        options: OPTIONS.ttsEnabled,
        helper:
          "Active l'outil « capture_libraire » : Libry capture une page web " +
          "(Chromium headless) et l'image est transmise à Yuki puis affichée dans " +
          "la conversation. ⚠️ Seules les URL http/https publiques sont " +
          "capturables.",
      },
      {
        path: "librarian.agentToken",
        label: "Jeton agent (facultatif)",
        kind: "secret",
        advanced: true,
        helper:
          "Facultatif (compatibilité). Renseigné, il est envoyé dans l'en-tête " +
          "Authorization ; vide, il n'est ni exigé ni envoyé — c'est la CLÉ " +
          "libraire ci-dessus qui authentifie. Jamais réaffiché en clair.",
      },
      {
        path: "librarian.archiveTimeoutMs",
        label: "Délai maximal de rédaction d'archive (ms)",
        kind: "number",
        min: 1000,
        max: 300000,
        advanced: true,
        helper:
          "Délai au-delà duquel la rédaction de la synthèse d'archivage est " +
          "abandonnée (l'échec est rapporté dans la conversation).",
      },
    ],
  },
  {
    id: "fichiers",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "execution" },
    title: "Fichiers échangés",
    fields: [
      {
        path: "files.maxFileBytes",
        label: "Taille maximale par fichier (octets)",
        kind: "number",
        min: 1048576,
        max: 8589934592,
        helper:
          "Plafond d'un fichier envoyé. Défaut 2 147 483 648 octets (2 Gio). " +
          "⚠️ Les fichiers vivent sur le MÊME volume que la configuration, la " +
          "mémoire et les conversations : un fichier démesuré remplirait le " +
          "disque et arrêterait Yuki. Au-delà du plafond, l'envoi est REFUSÉ " +
          "explicitement (rien n'est conservé).",
      },
      {
        path: "files.imageMaxBytes",
        label: "Taille maximale du FICHIER image transmis au modèle (octets)",
        kind: "number",
        min: 1,
        max: 20000000,
        helper:
          "Garde-fou de VISION sur les octets du FICHIER : au-delà, l'image est " +
          "RÉDUITE à la volée (côté max 2 000 px, côté min lisible 700 px) — " +
          "l'original enregistré, lui, n'est jamais modifié. ⚠️ Ce plafond ne " +
          "borne PAS ce qui part sur le fil (le base64 pèse ×1,33) : voir le " +
          "plafond TRANSMIS ci-dessous.",
      },
      {
        path: "files.imageMaxWireBytes",
        label: "Taille maximale TRANSMISE d'une image (octets base64)",
        kind: "number",
        min: 100000,
        max: 20000000,
        helper:
          "⚠️ La borne qui compte : le base64 pèse ×1,33 sur le fichier, et " +
          "c'est ce volume que le fournisseur refuse (`500 request entity too " +
          "large`). Défaut 700 000 octets (~0,7 Mo transmis). Au-delà, l'image " +
          "est RÉDUITE davantage : d'abord par le CÔTÉ, puis par RÉ-ENCODAGE " +
          "(JPEG) quand un PNG reste trop lourd — c'est ce ré-encodage qui fait " +
          "passer une capture de 2,9 Mo à ~0,5 Mo. Si elle ne peut pas l'être " +
          "sans devenir illisible, le message est REFUSÉ explicitement, AVANT " +
          "l'appel au fournisseur.",
      },
      {
        path: "files.imageRequestBudgetBytes",
        label: "Total maximal d'images TRANSMISES par requête (octets base64)",
        kind: "number",
        min: 1000,
        max: 60000000,
        helper:
          "⚠️ Le plafond d'UNE image ne suffit pas : l'historique entier repart " +
          "à CHAQUE tour, donc chaque image déjà vue repartait aussi. Ce plafond " +
          "borne le TOTAL des images d'une requête. Défaut 1 500 000 octets " +
          "(~1,5 Mo transmis, soit deux images pleines). Au-delà, les images les " +
          "plus ANCIENNES sont retirées AVANT l'appel et remplacées par un texte " +
          "qui dit la vérité (« déjà vue, relis-la avec lire_fichier ») : la " +
          "vision reste active, seule la répétition disparaît. 0 ⇒ pas de borne " +
          "(déconseillé : c'est ce qui produisait `500 request entity too large`).",
      },
      {
        path: "files.agentMaxBytes",
        label: "Transfert machine : plafond par transfert (octets)",
        kind: "number",
        min: 1048576,
        max: 8589934592,
        advanced: true,
        helper:
          "Plafond d'un fichier transféré vers ou depuis une machine appairée " +
          "(agent d'exécution). Défaut 268 435 456 octets (256 Mio). Au-delà, le " +
          "transfert est REFUSÉ avec un message qui dit d'utiliser run_command " +
          "(scp, rsync, tar…) : un transfert de plusieurs Gio bloquerait le tour " +
          "du modèle des minutes durant.",
      },
      {
        path: "files.agentChunkBytes",
        label: "Transfert machine : taille d'un morceau (octets)",
        kind: "number",
        min: 16384,
        max: 4194304,
        advanced: true,
        helper:
          "Taille binaire d'un morceau de transfert. Défaut 196 608 octets " +
          "(192 Kio, ~256 Kio en base64) : très en dessous de la trame maximale " +
          "du canal (8 Mio).",
      },
      {
        path: "files.agentTimeoutMs",
        label: "Transfert machine : délai maximal (ms)",
        kind: "number",
        min: 5000,
        max: 3600000,
        advanced: true,
        helper:
          "Délai au-delà duquel un transfert sans aucune trame reçue est " +
          "considéré comme interrompu. Une seule reprise est tentée à la " +
          "reconnexion ; au-delà, l'échec est dit (jamais un succès partiel).",
      },
      {
        path: "files.retentionDays",
        label: "Rétention des fichiers (jours)",
        kind: "number",
        min: 1,
        max: 3650,
        helper:
          "Durée de conservation d'un fichier ET de son analyse. À l'échéance, " +
          "les deux sont SUPPRIMÉS du disque (purge réelle, vérifiée au " +
          "démarrage puis toutes les 10 minutes).",
      },
      {
        path: "files.maxAttachments",
        label: "Fichiers joints par message (maximum)",
        kind: "number",
        min: 1,
        max: 20,
        helper:
          "Nombre maximal de fichiers envoyés avec un même message. Au-delà, " +
          "les fichiers en trop ne sont PAS joints et l'interface le dit.",
      },
      {
        path: "files.promptChars",
        label: "Contenu transmis au modèle par fichier (caractères)",
        kind: "number",
        min: 1000,
        max: 100000,
        helper:
          "BORNE d'injection : un fichier n'est jamais transmis en entier. " +
          "Au-delà, le modèle reçoit le début du texte et lit explicitement que " +
          "le contenu est tronqué (le fichier complet reste stocké et " +
          "téléchargeable).",
      },
      {
        path: "files.promptTotalChars",
        label: "Contenu transmis au modèle par message (caractères)",
        kind: "number",
        min: 1000,
        max: 400000,
        advanced: true,
        helper:
          "BORNE TOTALE : somme des contenus de TOUS les fichiers d'un message. " +
          "Les fichiers qui ne tiennent plus sont déclarés NON transmis (le " +
          "modèle le lit, rien n'est omis en silence).",
      },
    ],
  },
  {
    id: "sources",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "systeme" },
    // ⚠️ ENCART DE RENVOI : la BORNE d'injection est commune ; les
    // déclencheurs, eux, appartiennent au bot (`sources.json` par bot).
    renvoi: {
      instance: {
        texte:
          "Les déclencheurs d'un bot (création, réglages, journal) sont sur SA " +
          "page :",
        lien: { href: "/bots#declencheurs", libelle: "Bot · Déclencheurs" },
      },
    },
    title: "Notifications des sources (borne d'injection)",
    fields: [
      {
        path: "sources.promptTotalChars",
        label: "Notifications transmises au modèle en un tour (caractères)",
        kind: "number",
        min: 500,
        max: 40000,
        helper:
          "BORNE d'injection du bloc <sources> : les notifications en attente " +
          "partent GROUPÉES au début du prochain tour, jamais pendant. Au-delà de " +
          "cette borne, une entrée est déclarée NON transmise (le modèle le lit) " +
          "et son contenu entier reste dans la boîte de notifications.",
      },
    ],
  },
  {
    id: "images",
    // Onglet(s) qui portent ce groupe sur chaque page (voir `config-pages.js`).
    tabs: { instance: "images" },
    title: "Serveur et réglages d'images (ComfyUI)",
    // Bouton « Tester la connexion » dédié (route `POST /api/images/test`) : il
    // interroge `GET /system_stats` avec l'URL et la clé SAISIES, sans rien
    // enregistrer.
    test: "images",
    fields: [
      {
        path: "images.baseUrl",
        label: "URL du serveur ComfyUI",
        kind: "text",
        helper:
          "Adresse du serveur ComfyUI, ex. http://10.10.0.5:8188. ⚠️ Vide = aucun " +
          "serveur : l'outil de génération d'image refuse explicitement, avec la " +
          "marche à suivre. Modifiable À CHAUD : aucun redémarrage n'est nécessaire.",
      },
      {
        path: "images.apiKey",
        label: "Clé du serveur (facultative)",
        kind: "secret",
        helper:
          "Uniquement si votre ComfyUI est derrière un reverse-proxy authentifié " +
          "(envoyée en Authorization: Bearer). ⚠️ Jamais réaffichée en clair, " +
          "jamais journalisée, jamais transmise au modèle.",
      },
      {
        path: "images.width",
        label: "Largeur demandée (pixels)",
        kind: "number",
        min: 64,
        max: 4096,
        helper:
          "Écrite dans le nœud étiqueté YUKI_WIDTH, si le workflow en a un. Les " +
          "workflows qui ne portent pas cette étiquette l'ignorent.",
      },
      {
        path: "images.height",
        label: "Hauteur demandée (pixels)",
        kind: "number",
        min: 64,
        max: 4096,
        helper: "Écrite dans le nœud étiqueté YUKI_HEIGHT, si le workflow en a un.",
      },
      {
        path: "images.timeoutMs",
        // ⚠️ Le libellé garde le mot « délai » (contrat d'interface vérifié par
        // `_tools/e2e-image.mjs`) et dit ce que la valeur EST : un plafond.
        label: "Délai maximal d'une génération — plafond de sécurité (ms)",
        kind: "number",
        min: 10000,
        // ⚠️ Doit RESTER au-dessus du défaut (3 600 000) : sinon on ne peut pas
        // régler plus haut, et un défaut au maximum serait incohérent.
        max: 7200000,
        // ⚠️ PAS `advanced` : dans l'onglet « Images », le plafond est un réglage
        // d'image comme les autres — il doit être VISIBLE sans déplier « Avancé ».
        helper:
          "Filet de dernier recours, pas le mécanisme d'arrêt : Yuki demande à " +
          "ComfyUI l'état de sa file et attend tant que le serveur travaille " +
          "(une vidéo de 10 minutes passe donc, comme une génération d'une heure). " +
          "Un travail qui DISPARAÎT de la file sans résultat est constaté en 30 " +
          "secondes. Défaut 3 600 000 ms (1 heure), maximum 7 200 000 (2 heures). " +
          "Au-delà de 61 minutes, relevez aussi « Durée maximale d'un job » " +
          "(onglet Conversation, appliquée au redémarrage).",
      },
    ],
  },
];

export const ALL_FIELDS = GROUPS.flatMap((group) => group.fields);
export const LABELS = new Map(ALL_FIELDS.map((field) => [field.path, field.label]));
// `tts.voice` n'est plus un champ du groupe (la bibliothèque de la zone ② en est
// l'unique contrôle), mais son libellé reste utile pour les messages d'erreur.
LABELS.set("tts.voice", "Voix active");

/**
 * Valeurs par défaut des champs — **miroir UI** de `src/config/schema.ts`.
 * Sert UNIQUEMENT à l'aide « Valeur par défaut : X. » et au bouton
 * « Réinitialiser au défaut ». Le reset lui-même envoie `null` au serveur (qui
 * applique SON défaut) : cette table ne fige donc rien côté serveur, elle rend
 * seulement le contrôle cohérent immédiatement. Tenir synchronisée avec le
 * schéma (aucun accès au schéma depuis le navigateur).
 */
export const FIELD_DEFAULTS = {
  "llm.light.baseUrl": "https://ollama.com/v1",
  "llm.light.model": "gemma4:31b",
  "llm.light.vision": "oui",
  "llm.light.api": "openai-completions",
  "llm.light.thinking": "off",
  "llm.heavy.baseUrl": "https://ollama.com/v1",
  "llm.heavy.model": "deepseek-v4.1-flash",
  "llm.heavy.vision": "oui",
  "llm.heavy.api": "openai-completions",
  "llm.heavy.thinking": "high",
  "llm.missingKeyMode": "degrade",
  "delegation.defaultDeadlineMs": 1500,
  "delegation.maxConcurrent": 3,
  "delegation.maxQueue": 10,
  "delegation.idleTimeoutMs": 120000,
  "delegation.totalTimeoutMs": 4500000,
  "gpu.profile": "",
  "gpu.compatMode": "strict",
  "gpu.minDriver": 580,
  // ⚠️ `prompts.light` / `prompts.heavy` n'ont PAS d'entrée ici VOLONTAIREMENT :
  // leur défaut réel est le CONTENU DU FICHIER LIVRÉ (`config/pi/system-prompt.md`),
  // que le navigateur ne connaît pas. Il est servi par `GET /api/config`
  // (`fields["prompts.light"].default`, voir `src/config/runtime.ts`) et c'est
  // LUI que « Réinitialiser au défaut » réécrit. Une entrée `""` ici vidait la
  // zone de texte : c'était le défaut signalé (« si je fais réinitialiser au
  // défaut, c'est vide »).
  "memory.enabled": "on",
  "memory.recall.topK": 5,
  "memory.recall.budgetChars": 8000,
  "memory.recall.timeoutMs": 400,
  "memory.extract.maxItems": 3,
  "memory.extract.timeoutMs": 30000,
  "memory.consolidation.enabled": "on",
  "memory.consolidation.cron": "0 3 * * 0",
  "memory.consolidation.timeZone": "Europe/Paris",
  "memory.consolidation.budgetTokens": 200000,
  "memory.consolidation.retention": 12,
  "tts.enabled": "off",
  "tts.engine": "chatterbox",
  "tts.baseUrl": "http://tts:8081",
  "tts.language": "fr",
  "tts.emotion": "neutre",
  "tts.speed": 100,
  "tts.exaggeration": 500,
  "tts.cfg": 500,
  "tts.prefetchDepth": 2,
  "tts.minSentenceChars": 24,
  "tts.maxSentenceChars": 240,
  "tts.timeoutMs": 15000,
  "tts.volume": 100,
  "transport.replayBuffer": 1000,
  "transport.replayBytes": 5000000,
  // Fuseau des horodatages (réglage `ui.timeZone`) : **UTC** par défaut, comme
  // Mattermost — c'est ce qui rend les deux affichages corrélables.
  "ui.timeZone": "UTC",
  "push.enabled": "on",
  "push.contact": "mailto:yuki@localhost",
  "agents.serverName": "",
  "librarian.baseUrl": "",
  "librarian.screenshot": "on",
  "librarian.archiveTimeoutMs": 30000,
  "files.maxFileBytes": 2147483648,
  "files.agentMaxBytes": 268435456,
  "files.agentChunkBytes": 196608,
  "files.agentTimeoutMs": 120000,
  "files.imageMaxBytes": 3500000,
  "files.imageMaxWireBytes": 700000,
  "files.imageRequestBudgetBytes": 1500000,
  "files.retentionDays": 30,
  "files.maxAttachments": 5,
  "files.promptChars": 12000,
  "files.promptTotalChars": 24000,
  "images.baseUrl": "",
  "images.width": 1024,
  "images.height": 1024,
  "images.timeoutMs": 3600000,
};

