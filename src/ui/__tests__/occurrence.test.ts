import { describe, expect, it } from "vitest";
import { excerpt, isIgnored, sameOccurrence } from "../occurrence";

const shown = (parts: { before: string; name: string; after: string }) => `${parts.before}[${parts.name}]${parts.after}`;

describe("excerpt", () => {
  it("shows a short sentence whole, the name marked", () => {
    expect(shown(excerpt("It was a trick Mara had taught her.", "Mara", 20))).toBe("It was a trick [Mara] had taught her.");
  });

  it("keeps the words nearest the name in a long sentence, more after it than before", () => {
    const sentence = "one two three four five six seven eight nine Mara ten eleven twelve thirteen fourteen fifteen.";
    expect(shown(excerpt(sentence, "Mara", 8))).toBe("…eight nine [Mara] ten eleven twelve thirteen fourteen…");
  });

  it("gives the room left on one side to the other", () => {
    const sentence = "Mara one two three four five six seven eight nine.";
    expect(shown(excerpt(sentence, "Mara", 5))).toBe("[Mara] one two three four…");
    expect(shown(excerpt("one two three four five six seven Mara.", "Mara", 4))).toBe("…six seven [Mara].");
  });

  it("finds the name as a whole word, apostrophes and quotes being edges", () => {
    expect(shown(excerpt("Marianne saw Mara's boat.", "Mara", 10))).toBe("Marianne saw [Mara]'s boat.");
    expect(shown(excerpt("Le livre d'Arwen.", "Arwen", 10))).toBe("Le livre d'[Arwen].");
    expect(shown(excerpt("“Elena,” he said.", "Elena", 10))).toBe("“[Elena],” he said.");
  });

  it("shows the sentence, shortened, when the name isn't in it", () => {
    expect(excerpt("one two three four five", "Mara", 3)).toEqual({ before: "one two three…", name: "", after: "" });
  });
});

describe("isIgnored", () => {
  it("matches the name however its apostrophes were typed, and the sentence exactly", () => {
    const ignored = [{ name: "d'Arwen", sentence: "Le livre d'Arwen." }];
    expect(isIgnored(ignored, { name: "d’Arwen", sentence: "Le livre d'Arwen." })).toBe(true);
    expect(isIgnored(ignored, { name: "d'Arwen", sentence: "Le livre d'Arwen est là." })).toBe(false);
    expect(sameOccurrence({ name: "Rose", sentence: "A" }, { name: "Rose", sentence: "A" })).toBe(true);
  });
});
