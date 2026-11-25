import { describe, expect, it } from "vitest";
import { DEFAULT_REPLACEMENTS, NBSP, NNBSP, typedText, typographyFor, type Typography } from "../typography";

/** Types `keys` one by one into a paragraph, as an editor does with typedText. */
function type(keys: string, rules: Typography, replacements = DEFAULT_REPLACEMENTS, start = ""): string {
  let text = start;
  for (const key of keys) {
    const change = typedText(text, key, rules, replacements);
    text = change ? text.slice(0, text.length - change.replace) + change.insert : text + key;
  }
  return text;
}

describe("the rules of each language", () => {
  it("follows the project's language", () => {
    expect(typographyFor("en-GB")).toBe("en");
    expect(typographyFor("fr_CA")).toBe("fr");
    expect(typographyFor("es-MX")).toBe("es");
    expect(typographyFor("de")).toBe("none");
  });
});

describe("English", () => {
  it("curls quotes and apostrophes", () => {
    expect(type(`"Don't," she said. 'Come.'`, "en")).toBe("“Don’t,” she said. ‘Come.’");
    expect(type(`("Yes")`, "en")).toBe("(“Yes”)");
    expect(type(`the '90s`, "en")).toBe("the ‘90s");
  });

  it("turns two hyphens into an em dash, and leaves one alone", () => {
    expect(type("wait--no", "en")).toBe("wait—no");
    expect(type("sea-green", "en")).toBe("sea-green");
    expect(type("a---b", "en")).toBe("a—-b");
  });

  it("adds no space before punctuation", () => {
    expect(type("Why? Now!", "en")).toBe("Why? Now!");
  });
});

describe("French", () => {
  it("puts « » with no-break spaces inside", () => {
    expect(type(`"Oui", dit-il`, "fr")).toBe(`«${NBSP}Oui${NBSP}», dit-il`);
    expect(type(`"Oui "`, "fr")).toBe(`«${NBSP}Oui${NBSP}»`);
  });

  it("puts a narrow no-break space before ; ! ? and a no-break space before :", () => {
    expect(type("Quoi? Non!", "fr")).toBe(`Quoi${NNBSP}? Non${NNBSP}!`);
    expect(type("Voici : la liste;", "fr")).toBe(`Voici${NBSP}: la liste${NNBSP};`);
  });

  it("leaves times, doubled marks and a line's start alone", () => {
    expect(type("À 12:30", "fr")).toBe("À 12:30");
    expect(type("Quoi?!", "fr")).toBe(`Quoi${NNBSP}?!`);
    expect(type("?", "fr")).toBe("?");
  });

  it("keeps apostrophes typographic", () => {
    expect(type("l'auberge d'Arwen", "fr")).toBe("l’auberge d’Arwen");
  });
});

describe("Spanish", () => {
  it("opens dialogue with a dash, and quotes with « »", () => {
    expect(type(`--Hola --dijo. "Sí"`, "es")).toBe("—Hola —dijo. «Sí»");
    expect(type("¿Qué?", "es")).toBe("¿Qué?");
  });
});

describe("Markdown's emphasis markers", () => {
  it("open a quote after an opening marker, and close it after a closing one", () => {
    expect(type(`said *"Help!"*`, "en")).toBe("said *“Help!”*");
    expect(type(`dit **"Oui"**`, "fr")).toBe(`dit **«${NBSP}Oui${NBSP}»**`);
    expect(type(`dijo _"Sí"_`, "es")).toBe("dijo _«Sí»_");
    expect(type(`*'tis*`, "en")).toBe("*‘tis*");
  });

  it("are looked through by French spacing, which goes after them", () => {
    expect(type("*Quoi*?", "fr")).toBe(`*Quoi*${NNBSP}?`);
    expect(type("**Oui**!", "fr")).toBe(`**Oui**${NNBSP}!`);
    expect(type("_Voici_:", "fr")).toBe(`_Voici_${NBSP}:`);
    expect(type("*Quoi ?*!", "fr", [])).toBe(`*Quoi${NNBSP}?*!`);
    expect(type("*wich*?", "fr")).toBe(`*which*${NNBSP}?`);
  });

  it("let a replacement through on a word they close", () => {
    expect(type("the *teh* boat", "en")).toBe("the *the* boat");
    expect(type("**Teh**.", "none")).toBe("**The**.");
  });
});

describe("replacements", () => {
  it("replaces a word when it is ended, keeping its capital", () => {
    expect(type("teh boat", "en")).toBe("the boat");
    expect(type("Teh boat.", "en")).toBe("The boat.");
    expect(type("adn,", "en")).toBe("and,");
    expect(type("tehran ", "en")).toBe("tehran ");
  });

  it("works with the language's typography", () => {
    expect(type(`teh"`, "en")).toBe("the”");
    expect(type("wich ?", "fr")).toBe(`which${NNBSP}?`);
  });

  it("match apostrophes either way, and curl the replacement's with the typography", () => {
    const im = [{ from: "i'm", to: "I'm" }];
    expect(type("i'm here", "en", im)).toBe("I’m here");
    expect(type("i'm here", "none", im)).toBe("I'm here");
    expect(type("dont go", "en", [{ from: "dont", to: "don't" }])).toBe("don’t go");
  });

  it("replace symbols as soon as they are typed, before the typography", () => {
    const symbols = [
      { from: "(c)", to: "©" },
      { from: "->", to: "→" },
      { from: "...", to: "…" },
      { from: "--", to: "–" },
    ];
    expect(type("(c) 2026", "en", symbols)).toBe("© 2026");
    expect(type("a -> b", "en", symbols)).toBe("a → b");
    expect(type("Wait...", "en", symbols)).toBe("Wait…");
    expect(type("1--2", "en", symbols)).toBe("1–2");
  });

  it("match what was typed, whatever the typography made of it", () => {
    expect(type("I waited 'til dawn", "en", [{ from: "'til", to: "until" }])).toBe("I waited until dawn");
    expect(type("rock 'n' roll", "en", [{ from: "'n'", to: "and" }])).toBe("rock and roll");
    expect(type("a-->b", "en", [{ from: "-->", to: "→" }])).toBe("a→b");
    expect(type("a--->b", "en", [{ from: "->", to: "→" }])).toBe("a—→b");
    expect(type("it---", "en", [{ from: "---", to: "—" }])).toBe("it—");
    expect(type('say "hi"!', "en", [{ from: '"!', to: "”!!" }])).toBe("say “hi”!!");
  });

  it("count what they replace in the text's own characters", () => {
    const keys = ["a", "x", "😀"];
    let text = "";
    for (const key of keys) {
      const change = typedText(text, key, "en", [{ from: "x😀", to: "y" }]);
      text = change ? text.slice(0, text.length - change.replace) + change.insert : text + key;
    }
    expect(text).toBe("ay");
  });

  it("replace several words, from a word's start only", () => {
    const phrase = [{ from: "teh boat", to: "the boat" }];
    expect(type("in teh boat.", "en", phrase)).toBe("in the boat.");
    expect(type("Teh boat ", "en", phrase)).toBe("The boat ");
    expect(type("dateh boat ", "en", phrase)).toBe("dateh boat ");
  });

  it("works with no typography, and does nothing with no replacements", () => {
    expect(type("teh ", "none")).toBe("the ");
    expect(type(`teh "x"`, "none", [])).toBe(`teh "x"`);
  });
});
