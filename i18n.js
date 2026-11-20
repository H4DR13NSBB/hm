// =============================================================================
// Language: English by default, French when picked in the top bar. Saved per
// device, so each of you can have your own. Switching reloads the app.
//
// Strings are looked up by their English text. A "|context" suffix tells two
// identical English strings apart when French needs different words; it's
// dropped when showing the English.
// =============================================================================

import { FR } from "./i18n-fr.js";

const KEY = "duo-lang";

export const lang = (() => {
  try { return localStorage.getItem(KEY) === "fr" ? "fr" : "en"; } catch { return "en"; }
})();
export const locale = lang === "fr" ? "fr-FR" : "en-GB";

/** Translate `s`, filling in {name}-style placeholders from `vars`. */
export function tr(s, vars) {
  let out = (lang === "fr" && FR[s]) || s.split("|")[0];
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out;
}

export function setLang(l) {
  try { localStorage.setItem(KEY, l); } catch {}
  location.reload();
}

// The static HTML: elements whose whole inner HTML is a known string get
// swapped as one (so "Tap <b>+ New list</b> to…" reads naturally), otherwise
// each text node and label-ish attribute is looked up on its own.
const ATTRS = ["placeholder", "aria-label", "title"];
const norm = (s) => s.replace(/\s+/g, " ").trim();

export function translatePage(root = document.body) {
  document.documentElement.lang = lang;
  if (lang === "en") return;
  (function walk(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && FR[v]) el.setAttribute(a, FR[v]);
    }
    if (el.dataset?.i18n) { el.textContent = tr(el.dataset.i18n); return; }
    const html = norm(el.innerHTML);
    if (el.children.length && FR[html]) { el.innerHTML = FR[html]; return; }
    for (const n of [...el.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) {
        const fr = FR[norm(n.data)];
        if (fr) n.data = n.data.match(/^\s*/)[0] + fr + n.data.match(/\s*$/)[0];
      } else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== "SCRIPT") {
        walk(n);
      }
    }
  })(root);
}
