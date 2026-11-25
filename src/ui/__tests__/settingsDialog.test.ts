// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_POLICY_URL } from "../../core/about";
import { LANGUAGES } from "../../core/projects";
import { DEFAULT_SETTINGS, MAX_REPLACEMENTS, sanitizeSettings, type ViewSettings } from "../../core/settings";
import { DEFAULT_REPLACEMENTS } from "../../core/typography";
import { keptReplacements, SettingsDialog, type SettingsDialogProps } from "../SettingsDialog";

const onClose = vi.fn<() => void>();
const onLanguageChange = vi.fn<(code: string) => void>();
/** Applies the patch as useViewSettings does, and shows the dialog with the result. */
const update = vi.fn<(patch: Partial<ViewSettings>) => void>();

let container: HTMLDivElement;
let root: Root;
let props: SettingsDialogProps;
/** What had focus before the dialog opened: the chapter, say. */
let field: HTMLTextAreaElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  onClose.mockReset();
  onLanguageChange.mockReset();
  update.mockReset();
  update.mockImplementation((patch) => {
    props = { ...props, settings: sanitizeSettings({ ...props.settings, ...patch }) };
    root.render(createElement(SettingsDialog, props));
  });
  props = {
    open: true,
    onClose,
    isPhone: false,
    settings: DEFAULT_SETTINGS,
    update,
    language: "en-GB",
    onLanguageChange,
  };
  container = document.createElement("div");
  field = document.createElement("textarea");
  document.body.append(field, container);
  field.focus();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  field.remove();
});

function render(patch: Partial<SettingsDialogProps> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(createElement(SettingsDialog, props)));
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const scrim = () => document.querySelector<HTMLElement>(".settings-scrim")!;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const labelled = (text: string) => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === text);
  return label ? document.getElementById(label.htmlFor) : null;
};
const select = (text: string) => labelled(text) as HTMLSelectElement;
const input = (text: string) => labelled(text) as HTMLInputElement | null;
const switchNamed = (name: string) => labelled(name) as HTMLButtonElement;
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
const notes = () => [...document.querySelectorAll(".settings-note")].map((n) => n.textContent);
const privacy = () => document.querySelector(".settings-privacy")?.textContent ?? null;
const rows = () => [...document.querySelectorAll<HTMLLIElement>(".replacement-list li")];
const rowFields = (row: HTMLElement) => [...row.querySelectorAll<HTMLInputElement>("input")];
const shownReplacements = () => rows().map((r) => rowFields(r).map((i) => i.value));
const lastPatch = () => update.mock.lastCall?.[0];

const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

/** Types `value` into a field, as one change, with the field focused. */
function type(el: HTMLInputElement, value: string) {
  act(() => {
    el.focus();
    setInputValue.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const leave = (el: HTMLElement) => act(() => el.blur());
const click = (el: HTMLElement) => act(() => el.click());

function key(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function mouse(type: "mousedown" | "click", target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

describe("opening and closing", () => {
  it("renders nothing when closed", () => {
    render({ open: false });
    expect(dialog()).toBeNull();
    expect(document.querySelector(".settings-scrim, .settings-sheet")).toBeNull();
    render({ open: false, isPhone: true });
    expect(document.querySelector(".settings-sheet")).toBeNull();
  });

  it("is a modal dialog named by its heading, with focus inside", () => {
    render();
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Settings");
    expect(document.activeElement).toBe(d);
    expect(d.closest(".settings-scrim")?.parentElement).toBe(document.body);
  });

  it("Escape closes it, and focus goes back where it was", () => {
    render();
    const event = key({ key: "Escape" });
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    render({ open: false });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("Done closes it; there is nothing to save", () => {
    render();
    expect(buttonNamed("Save")).toBeUndefined();
    click(buttonNamed("Done"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab and Shift+Tab go round the dialog", () => {
    render();
    key({ key: "Tab" });
    expect(document.activeElement).toBe(select("Language"));
    key({ key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttonNamed("Done"));
    key({ key: "Tab" });
    expect(document.activeElement).toBe(select("Language"));
  });

  it("a click on the scrim closes it; a drag from inside the dialog doesn't", () => {
    render();
    mouse("mousedown", dialog()!);
    mouse("click", scrim());
    expect(onClose).not.toHaveBeenCalled();
    mouse("mousedown", scrim());
    mouse("click", scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closing keeps what was being typed", () => {
    render();
    const [, to] = rowFields(rows()[0]);
    type(to, "thee");
    expect(update).not.toHaveBeenCalled();
    key({ key: "Escape" });
    expect(lastPatch()?.replacements?.[0]).toEqual({ from: "teh", to: "thee" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("phones: a sheet from the bottom, its close button focused", () => {
    render({ isPhone: true });
    const sheet = document.querySelector<HTMLElement>(".bottom-sheet.settings-sheet")!;
    expect(sheet.classList.contains("is-open")).toBe(true);
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(sheet.getAttribute("aria-labelledby")!)?.textContent).toBe("Settings");
    expect(document.activeElement).toBe(buttonNamed("Close"));
    expect(buttonNamed("Done")).toBeUndefined();
    expect(switchNamed("Spelling")).not.toBeNull();
    click(buttonNamed("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    render({ isPhone: true, open: false });
    expect(sheet.classList.contains("is-open")).toBe(false);
    expect(sheet.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("phones: Escape closes the sheet", () => {
    render({ isPhone: true });
    key({ key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("switches", () => {
  it.each([
    ["Spelling", "spelling", false],
    ["Grammar", "grammar", false],
    ["Typography as you type", "typography", false],
    ["Typewriter scrolling", "typewriter", true],
  ] as const)("%s turns %s to %s", (label, setting, value) => {
    render();
    const toggle = switchNamed(label);
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe(String(!value));
    click(toggle);
    expect(update).toHaveBeenCalledWith({ [setting]: value });
    expect(switchNamed(label).getAttribute("aria-checked")).toBe(String(value));
  });
});

describe("theme", () => {
  it("is chosen from System, Light and Dark", () => {
    render();
    const group = document.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Theme");
    const options = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(options.map((o) => o.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    click(options[2]);
    expect(update).toHaveBeenCalledWith({ theme: "dark" });
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    click(options[2]);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("the project's language", () => {
  it("lists the languages by name, and changes the project's", () => {
    render();
    const list = select("Language");
    expect([...list.options].map((o) => o.textContent)).toEqual(LANGUAGES.map((l) => l.label));
    expect(list.value).toBe("en-GB");
    choose(list, "fr-FR");
    expect(onLanguageChange).toHaveBeenCalledWith("fr-FR");
    expect(update).not.toHaveBeenCalled();
  });

  it("shows a language that isn't in the list as one more", () => {
    render({ language: "de-DE" });
    const list = select("Language");
    expect(list.options).toHaveLength(LANGUAGES.length + 1);
    expect(list.value).toBe("de-DE");
    expect(list.selectedOptions[0].textContent).toBe("German (Germany)");
  });

  it("shows why a change was refused, and keeps the language", () => {
    onLanguageChange.mockImplementation(() => {
      throw new Error("Couldn’t write project.json: the disk is full.");
    });
    render();
    choose(select("Language"), "es-ES");
    expect(alerts()).toEqual(["Couldn’t write project.json: the disk is full."]);
    expect(select("Language").value).toBe("en-GB");
    expect(select("Language").getAttribute("aria-invalid")).toBe("true");
    onLanguageChange.mockReset();
    choose(select("Language"), "fr-FR");
    expect(alerts()).toEqual([]);
  });

  it("says what typography as you type does in it", () => {
    render();
    expect(notes()).toContain("In English: curly “quotes” and apostrophes, and — from two hyphens.");
    render({ language: "fr-CA" });
    expect(notes()).toContain("In French: «\u00a0guillemets\u00a0», and a no-break space before ; : ! ?");
    render({ language: "es-MX" });
    expect(notes()).toContain("In Spanish: «comillas», and the dialogue dash — from two hyphens.");
    render({ language: "de-DE" });
    expect(notes()).toContain("Only in English, French and Spanish projects.");
  });

  it("says who checks its grammar", () => {
    render();
    expect(notes()).toContain("English is checked on this device, offline.");
    render({ language: "fr-FR" });
    expect(notes()).toContain("French needs a grammar server: choose one below.");
  });
});

describe("the grammar server", () => {
  const server = () => select("Grammar server");

  it("is off at first, with nothing more to fill in", () => {
    render();
    expect([...server().options].map((o) => o.textContent)).toEqual([
      "Off",
      "languagetool.org (free)",
      "LanguageTool Premium",
      "Your own server",
    ]);
    expect(server().value).toBe("off");
    expect(input("User name")).toBeNull();
    expect(input("API key")).toBeNull();
    expect(input("Server address")).toBeNull();
    expect(privacy()).toBeNull();
  });

  it("languagetool.org: says the paragraphs go to LanguageTool, with the privacy policy", () => {
    render();
    choose(server(), "public");
    expect(update).toHaveBeenCalledWith({ languageTool: { mode: "public", url: "", username: "", apiKey: "" } });
    expect(privacy()).toContain("The paragraphs being checked are sent to LanguageTool.");
    expect(privacy()).toContain("about 20 checks a minute");
    const link = document.querySelector<HTMLAnchorElement>(".settings-privacy a")!;
    expect(link.textContent).toBe("Privacy policy");
    expect(link.href).toBe(PRIVACY_POLICY_URL);
    expect(notes()).toContain("Checked by languagetool.org, for every language, English included.");
  });

  it("opens the privacy policy in the system browser, or shows its address", async () => {
    const openUrl = vi.fn<(url: string) => Promise<void>>().mockRejectedValue(new Error("no browser"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render({ openUrl, settings: { ...DEFAULT_SETTINGS, languageTool: { ...DEFAULT_SETTINGS.languageTool, mode: "public" } } });
    const link = document.querySelector<HTMLAnchorElement>(".settings-privacy a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
    expect(alerts().join(" ")).toContain(PRIVACY_POLICY_URL);
    quiet.mockRestore();
  });

  it("Premium: a user name and an API key, kept as each field is left", () => {
    render();
    choose(server(), "premium");
    expect(notes()).toContain("Add your user name and API key below.");
    const key = input("API key")!;
    expect(key.type).toBe("password");
    update.mockClear();
    type(input("User name")!, " writer@example.com ");
    expect(update).not.toHaveBeenCalled();
    leave(input("User name")!);
    expect(update).toHaveBeenCalledWith({
      languageTool: { mode: "premium", url: "", username: "writer@example.com", apiKey: "" },
    });
    expect(input("User name")!.value).toBe("writer@example.com");
    type(input("API key")!, "secret-key");
    leave(input("API key")!);
    expect(lastPatch()?.languageTool).toEqual({
      mode: "premium",
      url: "",
      username: "writer@example.com",
      apiKey: "secret-key",
    });
    expect(privacy()).toContain("The paragraphs being checked are sent to LanguageTool.");
    expect(privacy()).not.toContain("20 checks");
    expect(notes()).toContain("Checked by your LanguageTool Premium account, for every language, English included.");
  });

  it("your own server: its address must start with http:// or https://", () => {
    render();
    choose(server(), "own");
    expect(privacy()).toBeNull();
    const address = input("Server address")!;
    expect(address.placeholder).toBe("http://localhost:8081");
    update.mockClear();
    type(address, "localhost:8081");
    leave(address);
    expect(update).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["The address must start with http:// or https://."]);
    expect(address.getAttribute("aria-invalid")).toBe("true");
    // The reason goes as soon as the address will do; Enter keeps it.
    type(address, "http://localhost:8081");
    expect(alerts()).toEqual([]);
    key({ key: "Enter" }, address);
    expect(update).toHaveBeenCalledWith({
      languageTool: { mode: "own", url: "http://localhost:8081", username: "", apiKey: "" },
    });
    expect(notes()).toContain("Checked by your own server, for every language, English included.");
  });

  it("Done waits for an address that can't be kept, and says why", () => {
    render({ settings: { ...DEFAULT_SETTINGS, languageTool: { ...DEFAULT_SETTINGS.languageTool, mode: "own" } } });
    const address = input("Server address")!;
    type(address, "ftp://example.com");
    click(buttonNamed("Done"));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(address);
    expect(alerts()).toEqual(["The address must start with http:// or https://."]);
    // Another server: nothing waits any more.
    choose(server(), "off");
    click(buttonNamed("Done"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes with grammar turned off", () => {
    render();
    click(switchNamed("Grammar"));
    expect(labelled("Grammar server")).toBeNull();
    expect(notes()).not.toContain("English is checked on this device, offline.");
  });
});

describe("replacements", () => {
  it("lists the replacements, and keeps an edit once its field is left", () => {
    render();
    expect(shownReplacements()).toEqual(DEFAULT_REPLACEMENTS.map((r) => [r.from, r.to]));
    const [, to] = rowFields(rows()[0]);
    type(to, "thee");
    expect(update).not.toHaveBeenCalled();
    leave(to);
    expect(update).toHaveBeenCalledTimes(1);
    expect(lastPatch()?.replacements).toEqual([{ from: "teh", to: "thee" }, ...DEFAULT_REPLACEMENTS.slice(1)]);
    // Leaving again without a change keeps nothing more.
    to.focus();
    leave(to);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps an edit on Enter", () => {
    render();
    const [from] = rowFields(rows()[1]);
    type(from, "nad");
    key({ key: "Enter" }, from);
    expect(lastPatch()?.replacements?.[1]).toEqual({ from: "nad", to: "and" });
    expect(document.activeElement).toBe(from);
  });

  it("adds a row, kept once it has a word on both sides", () => {
    render();
    click(buttonNamed("Add a replacement"));
    expect(rows()).toHaveLength(DEFAULT_REPLACEMENTS.length + 1);
    const [from, to] = rowFields(rows().at(-1)!);
    expect(document.activeElement).toBe(from);
    type(from, "hte");
    leave(from);
    expect(update).not.toHaveBeenCalled();
    type(to, "the");
    leave(to);
    expect(lastPatch()?.replacements).toEqual([...DEFAULT_REPLACEMENTS, { from: "hte", to: "the" }]);
  });

  it("removes a row at once, and focus goes to the next row's Remove", () => {
    render();
    click(buttonNamed("Remove adn"));
    expect(lastPatch()?.replacements).toEqual(DEFAULT_REPLACEMENTS.filter((r) => r.from !== "adn"));
    expect(shownReplacements().map(([from]) => from)).not.toContain("adn");
    expect(document.activeElement).toBe(buttonNamed("Remove taht"));
  });

  it("says when there are none, and focus goes to Add a replacement", () => {
    render({ settings: { ...DEFAULT_SETTINGS, replacements: [{ from: "teh", to: "the" }] } });
    click(buttonNamed("Remove teh"));
    expect(lastPatch()).toEqual({ replacements: [] });
    expect(rows()).toHaveLength(0);
    expect(notes()).toContain("No replacements.");
    expect(document.activeElement).toBe(buttonNamed("Add a replacement"));
  });

  it("stops adding at the most the list holds", () => {
    const many = Array.from({ length: MAX_REPLACEMENTS }, (_, i) => ({ from: `w${i}`, to: `word${i}` }));
    render({ settings: { ...DEFAULT_SETTINGS, replacements: many } });
    expect(buttonNamed("Add a replacement").disabled).toBe(true);
    expect(notes()).toContain(`The list holds up to ${MAX_REPLACEMENTS} replacements.`);
  });

  it("keeps rows with a word on both sides, trimmed, that aren't the same word", () => {
    expect(
      keptReplacements([
        { from: " teh ", to: " the " },
        { from: "", to: "and" },
        { from: "hte", to: "" },
        { from: "same", to: "same" },
        { from: "btw", to: "by the way" },
      ]),
    ).toEqual([
      { from: "teh", to: "the" },
      { from: "btw", to: "by the way" },
    ]);
  });
});
