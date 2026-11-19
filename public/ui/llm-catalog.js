const roles = ["light", "heavy"];
const labels = { light: "léger", heavy: "lourd" };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function renderCatalog({ container, fields, bot, legacyGroups, renderField, testConnection, changed }) {
  const initial = fields["llm.catalog"]?.value;
  const catalog = initial ? JSON.parse(initial) : { providers: [], models: [], light: "light", heavy: "heavy" };
  const baseline = JSON.stringify(catalog);
  const keys = {};
  const selections = {};
  const sections = [];
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");
  const providerName = key => catalog.providers.find(p => p.id === key)?.name || ("Compte " + labels[key]);
  const preserved = new Map();
  const legacyName = role => {
    const path = "llm." + role + ".model";
    return preserved.get(path)?.querySelector("input")?.value || fields[path]?.value || role;
  };
  const legacyProviders = roles.map(role => [role, providerName(role)]);
  const modelOptions = () => [
    ...roles.map(role => [role, legacyName(role) + " · " + providerName(role)]),
    ...catalog.models.map(m => [m.id, (m.model || "Nouveau modèle") + " · " + providerName(m.provider)]),
  ];
  function section(title) {
    const node = element("section", "", "config-group");
    node.append(element("h2", title, "config-group__title"));
    container.append(node);
    sections.push(node);
    return node;
  }
  function control(parent, label, value, update, options, type = "text") {
    const row = element("label", "", "config-row");
    row.append(element("span", label, "config-label"));
    const input = element(options ? "select" : "input", "", options ? "config-select" : "config-input");
    if (options) {
      for (const [key, name] of options) input.add(new Option(name, key));
    } else input.type = type;
    input.value = value;
    input.addEventListener(options ? "change" : "input", () => { update(input.value); changed(); });
    row.append(input);
    parent.append(row);
    return input;
  }
  function button(parent, label, click) {
    const node = element("button", label, "button button--ghost button--small");
    node.type = "button";
    node.onclick = () => { click(); draw(); changed(); };
    parent.append(node);
  }
  function connection(parent, role, provider, key) {
    const status = element("span", "", "config-helper");
    const test = element("button", "Tester la connexion", "button button--ghost button--small");
    test.type = "button";
    test.onclick = () => testConnection(role, status, provider, key?.value);
    parent.append(test, status);
  }
  function draw() {
    for (const node of sections.splice(0)) node.remove();
    if (!bot) {
      const providers = section("Fournisseurs");
      for (const group of legacyGroups) {
        providers.append(element("h3", providerName(group.role)));
        for (const f of group.fields.filter(f => /\.(api|baseUrl|apiKey)$/.test(f.path))) providers.append(renderField(f));
        connection(providers, group.role);
      }
      for (const p of catalog.providers) {
        providers.append(element("h3", p.name || "Nouveau fournisseur"));
        const name = control(providers, "Nom du fournisseur", p.name, v => p.name = v);
        name.onchange = refreshChoices;
        control(providers, "URL de base compatible OpenAI", p.baseUrl, v => p.baseUrl = v, null, "url");
        const path = "llm.provider." + p.id + ".apiKey";
        const key = control(providers, "Clé API", keys[path] ?? "", v => { if (v) keys[path] = v; else delete keys[path]; }, null, "password");
        key.placeholder = fields[path]?.configured ? "Clé enregistrée" : "";
        if (fields[path]) connection(providers, undefined, p.id, key);
        if (fields[path]?.configured) button(providers, "Effacer la clé", () => keys[path] = null);
        const remove = element("button", "Supprimer le fournisseur", "button button--ghost button--small");
        remove.type = "button";
        remove.disabled = catalog.models.some(m => m.provider === p.id);
        remove.onclick = () => { catalog.providers = catalog.providers.filter(item => item !== p); delete keys[path]; draw(); changed(); };
        providers.append(remove);
      }
      button(providers, "Ajouter un fournisseur", () => catalog.providers.push({ id: id(), name: "", baseUrl: "" }));
    }
    const models = section(bot ? "LLM" : "Modèles");
    if (!bot) {
      for (const group of legacyGroups) {
        models.append(element("h3", "Modèle du compte " + labels[group.role]));
        for (const f of group.fields.filter(f => /\.(model|thinking|vision)$/.test(f.path))) models.append(renderField(f));
      }
      for (const m of catalog.models) {
        models.append(element("h3", m.model || "Nouveau modèle"));
        const providers = [...legacyProviders, ...catalog.providers.map(p => [p.id, p.name || "Nouveau fournisseur"])];
        control(models, "Fournisseur", m.provider, v => { m.provider = v; draw(); }, providers).dataset.providerPicker = "";
        const name = control(models, "Identifiant du modèle chez le fournisseur", m.model, v => m.model = v);
        name.onchange = refreshChoices;
        control(models, "Réflexion", m.thinking, v => m.thinking = v, ["off","minimal","low","medium","high","xhigh","max"].map(v => [v,v]));
        control(models, "Reçoit les images", String(m.vision), v => m.vision = v === "true", [["true","Oui"],["false","Non"]]);
        button(models, "Supprimer le modèle", () => {
          catalog.models = catalog.models.filter(item => item !== m);
          for (const role of roles) if (catalog[role] === m.id) catalog[role] = role;
        });
      }
      button(models, "Ajouter un modèle", () => catalog.models.push({ id: id(), provider: catalog.providers[0]?.id ?? "light", model: "", thinking: "off", vision: false }));
    }
    for (const role of roles) {
      const path = "llm.selection." + role;
      const options = modelOptions();
      const inherited = options.find(([key]) => key === catalog[role])?.[1];
      if (bot) options.unshift(["", "Par défaut · " + inherited]);
      const value = bot ? selections[path] ?? fields[path]?.value ?? "" : catalog[role];
      const select = control(models, "Modèle " + labels[role] + (bot ? "" : " par défaut"), value, v => {
        if (bot) selections[path] = v; else catalog[role] = v;
      }, options);
      if (select.selectedIndex < 0) select.value = "";
      select.dataset.catalogRole = role;
    }
  }
  // Keep legacy controls mounted while editing the dynamic lists.
  const original = renderField;
  renderField = f => {
    if (!preserved.has(f.path)) {
      const node = original(f);
      if (f.path.endsWith(".model")) node.addEventListener("change", refreshChoices);
      preserved.set(f.path, node);
    }
    return preserved.get(f.path);
  };
  function refreshChoices() {
    for (const select of container.querySelectorAll("select[data-provider-picker]")) {
      for (const option of select.options) option.text = providerName(option.value) || "Nouveau fournisseur";
    }
    for (const select of container.querySelectorAll("select[data-catalog-role]")) {
      const selected = select.value;
      select.replaceChildren(...modelOptions().map(([key, name]) => new Option(name, key)));
      select.value = selected;
    }
  }
  draw();
  return () => {
    const patch = { ...keys };
    if (!bot && JSON.stringify(catalog) !== baseline) patch["llm.catalog"] = JSON.stringify(catalog);
    for (const [path, value] of Object.entries(selections)) if (value !== fields[path]?.value) patch[path] = value || null;
    return patch;
  };
}
