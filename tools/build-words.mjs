// =============================================================================
// Builds the big word-of-the-day decks in words/<lang>.json from Wiktionary.
//
//   node tools/build-words.mjs [fr nl de it ja]
//
// Streams the Wiktionary extract from kaikki.org (CC BY-SA, hundreds of MB per
// language, nothing is saved) and keeps the most common real words, ranked by
// the OpenSubtitles frequency lists from github.com/hermitdave/FrequencyWords
// (MIT). Inflected forms ("ist", "gatti"), names, and obsolete, rare or
// offensive senses are left out. Words already in the hand-written deck
// (words-data.js, words-nl.js, …) are skipped, since those come first.
// Entries are [word, English, reading?], like the hand-written decks.
// =============================================================================

import { writeFileSync, mkdirSync } from "fs";
import { pathToFileURL, fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOW_MANY = 3000;

const LANGS = {
  fr: { name: "French", deck: "words-data.js", freq: "2018/fr/fr_50k.txt" },
  nl: { name: "Dutch", deck: "words-nl.js", freq: "2018/nl/nl_50k.txt" },
  de: { name: "German", deck: "words-de.js", freq: "2018/de/de_50k.txt" },
  it: { name: "Italian", deck: "words-it.js", freq: "2018/it/it_50k.txt" },
  ja: { name: "Japanese", deck: "words-ja.js", freq: "2016/ja/ja_50k.txt" },
};
const POS = ["noun", "verb", "adj", "adv", "intj", "phrase"];
const BAD = ["form-of", "alt-of", "obsolete", "archaic", "dated", "rare", "historical", "misspelling",
  "vulgar", "offensive", "derogatory", "slur", "ethnic", "abbreviation", "initialism", "acronym", "nonstandard"];

/** "le chat" → "chat", "l'eau (f)" → "eau", so hand-written words aren't repeated. */
const bare = (w) => w.replace(/\s*\(.*?\)/g, "").replace(/^(le|la|les|l'|de|het|der|die|das|il|lo|gli|i|un|una)\s*/i, "").trim().toLowerCase();

function article(lang, word, g) {
  const vowel = /^[aeiouàâéèêëîïôöùûüœæy]/i.test(word) || (lang === "it" && /^h/i.test(word));
  if (g === "p") return { nl: `de ${word}`, de: `die ${word}`, fr: `les ${word}`, it: `${word} (pl)` }[lang];
  if (!g) return word;
  if (lang === "nl") return `${g === "n" ? "het" : "de"} ${word}`;
  if (lang === "de") return `${{ m: "der", f: "die", n: "das" }[g] || ""} ${word}`.trim();
  if (lang === "fr") {
    if (/^h/i.test(word)) return `${word} (${g})`; // h muet or h aspiré? Wiktionary doesn't say
    return vowel ? `l'${word} (${g})` : `${g === "f" ? "la" : "le"} ${word}`;
  }
  if (lang === "it") {
    if (vowel) return `l'${word} (${g})`;
    if (g === "f") return `la ${word}`;
    return /^(s[^aeiou]|z|gn|ps|x|y|pn)/i.test(word) ? `lo ${word}` : `il ${word}`;
  }
  return word;
}

function gender(e, sense) {
  const t = new Set([...(e.tags || []), ...(sense.tags || [])]);
  if (t.has("plural") || t.has("plural-only")) return "p";
  if (t.has("neuter")) return "n";
  if (t.has("masculine") && !t.has("feminine")) return "m";
  if (t.has("feminine") && !t.has("masculine")) return "f";
  if (t.has("common")) return "m"; // Dutch de-words
  return null;
}

/** 食べる + ruby [[食, た]] → たべる */
function kana(form) {
  let out = "", rest = form.form;
  for (const [k, r] of form.ruby || []) {
    const i = rest.indexOf(k);
    if (i < 0) return null;
    out += rest.slice(0, i) + r;
    rest = rest.slice(i + k.length);
  }
  return out + rest;
}

/** The first sense or two, as short as they can be: "of, from", not "of, from; from". */
function english(senses) {
  const out = [];
  for (const s of senses) {
    let g = (s.glosses || [])[0];
    if (!g) continue;
    if (/^(combined form|compound|contraction|apocopic form|elided form|plural|feminine|masculine|diminutive|augmentative)( form)? of /i.test(g) || /\b(spelling|forms?) of\b/i.test(g)) continue;
    g = g.replace(/[[\]]/g, "");
    g = g.replace(/^synonym of .*?\(“(.+?)”\)$/i, "$1");
    if (/^[A-Z][a-z]/.test(g) && g.split(" ").length > 3) continue; // a usage note, not a translation
    g = g.replace(/\s*\([^()]*\)/g, "").replace(/\s*:$/, "").replace(/\.$/, "").trim();
    const parts = g.split(/,\s*/).filter((x) => x && !out.some((o) => o.toLowerCase() === x.toLowerCase()));
    if (!parts.length || parts.join(", ").length > 50) continue;
    out.push(...parts);
    if (out.join(", ").length > 30) break;
  }
  return out.slice(0, 4).join(", ");
}

async function* lines(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  let buf = "";
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

async function build(code) {
  const L = LANGS[code];
  const freqText = await (await fetch(`https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/${L.freq}`)).text();
  const rank = new Map();
  freqText.split("\n").forEach((l, i) => {
    const w = l.split(" ")[0]?.trim();
    if (w && !rank.has(w)) rank.set(w, i);
  });
  const hand = new Set((await import(pathToFileURL(join(ROOT, L.deck)))).WORDS.map((w) => bare(w[0])));

  // A word is skipped if its main entry (the first one) is a function word we
  // don't teach, or if it's also an inflected form: then its frequency mostly
  // counts the inflection ("was" is "laundry", but mostly "was" from "zijn").
  const found = new Map(); // word → { r, item }
  const seen = new Set(), spoilt = new Set();
  let n = 0;
  for await (const line of lines(`https://kaikki.org/dictionary/${L.name}/kaikki.org-dictionary-${L.name}.jsonl`)) {
    if (++n % 200000 === 0) console.error(code, n, "entries,", found.size, "kept");
    if (!line) continue;
    const e = JSON.parse(line);
    const w = e.word;
    if (!w) continue;
    // by lower case, so German "Ich" doesn't get the frequency of "ich"
    const k = code === "ja" ? w : w.toLowerCase();
    if (e.pos === "name" || e.pos === "character") continue; // a different word, really
    const first = !seen.has(k);
    seen.add(k);
    if (e.senses?.length && e.senses.every((s) => s.form_of || (s.tags || []).includes("form-of"))) spoilt.add(k);
    if ((first && !POS.includes(e.pos)) || spoilt.has(k)) { found.delete(k); spoilt.add(k); continue; }
    if (!POS.includes(e.pos) || found.has(k) || /\d/.test(w)) continue;
    if (code !== "de" && w[0] !== w[0].toLowerCase()) continue; // names
    const r = rank.get(k);
    if (r == null || hand.has(bare(w))) continue;
    if ((e.senses?.[0]?.tags || []).some((t) => ["vulgar", "offensive", "derogatory", "slur"].includes(t))) continue;
    const senses = (e.senses || []).filter((s) => !s.form_of && !s.alt_of && !(s.tags || []).some((t) => BAD.includes(t)));
    const en = english(senses);
    if (!en) continue;

    let item;
    if (code === "ja") {
      const roma = (e.forms || []).find((f) => (f.tags || []).includes("romanization"))?.form;
      if (!roma) continue;
      const canon = (e.forms || []).find((f) => (f.tags || []).includes("canonical") && f.ruby?.length);
      const reading = canon ? kana(canon) : null;
      const shown = canon?.form.startsWith(w) ? canon.form : w; // 強化 → 強化する, to match the reading
      item = [shown, en, reading && reading !== shown ? `${reading} · ${roma}` : roma];
    } else {
      item = [e.pos === "noun" ? article(code, w, gender(e, senses[0])) : w, en];
    }
    found.set(k, { r, item });
  }
  for (const w of spoilt) found.delete(w);
  const words = [...found.values()].sort((a, b) => a.r - b.r).slice(0, HOW_MANY).map((x) => x.item);
  mkdirSync(join(ROOT, "words"), { recursive: true });
  writeFileSync(join(ROOT, "words", `${code}.json`), JSON.stringify(words).replace(/\],\[/g, "],\n["));
  console.error(code, "done:", words.length, "words");
}

const codes = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LANGS);
await Promise.all(codes.map(build));
