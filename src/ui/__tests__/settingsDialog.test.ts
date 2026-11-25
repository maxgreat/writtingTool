// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_POLICY_URL } from "../../core/about";
import { LANGUAGES } from "../../core/projects";
import { DEFAULT_SETTINGS, MAX_REPLACEMENTS, sanitizeSettings, type ViewSettings } from "../../core/settings";
import type { DropboxBackend, DropboxStatus } from "../../core/backend";
import { DEFAULT_REPLACEMENTS } from "../../core/typography";
import { useDropbox, type DropboxConnection, type DropboxView } from "../../core/useDropbox";
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

describe("Dropbox", () => {
  const connect = vi.fn<() => Promise<void>>();
  const submitCode = vi.fn<(code: string) => Promise<void>>();
  const cancelSignIn = vi.fn<() => Promise<void>>();
  const disconnect = vi.fn<() => Promise<void>>();
  const ACCOUNT = { accountId: "dbid:1", name: "Ada Lovelace", email: "ada@example.com" };
  const USE = "Keep your projects in your own Dropbox to open them on your other devices.";
  const REACH = "The app sees only its own folder, in Dropbox’s Apps folder.";
  const KEYRING = "This computer has no keyring service, so your sign-in is kept in a file only your user account can read.";

  beforeEach(() => {
    for (const action of [connect, submitCode, cancelSignIn, disconnect]) action.mockReset().mockResolvedValue(undefined);
  });

  const connection = (view: DropboxView, more: Partial<DropboxConnection> = {}): DropboxConnection => ({
    view,
    error: null,
    note: null,
    connect,
    submitCode,
    cancel: cancelSignIn,
    disconnect,
    ...more,
  });
  const show = (view: DropboxView, more: Partial<DropboxConnection> = {}) => render({ dropbox: connection(view, more) });

  const section = () =>
    [...document.querySelectorAll("section")].find((s) => s.querySelector("h3")?.textContent === "Dropbox") ?? null;
  const item = () => section()!.querySelector<HTMLElement>(".dropbox")!;
  const buttons = () => [...section()!.querySelectorAll("button")];
  const names = () => buttons().map((b) => b.textContent);
  const account = () => section()!.querySelector<HTMLElement>(".dropbox-account");

  it("isn't there without a connection to show", () => {
    render();
    expect(section()).toBeNull();
    render({ dropbox: null });
    expect(section()).toBeNull();
  });

  it("comes right after the project's settings", () => {
    show({ step: "disconnected" });
    const titles = [...document.querySelectorAll(".settings-section-title")].map((t) => t.textContent);
    expect(titles).toEqual(["This project", "Dropbox", "Checking", "Typing", "Appearance"]);
    expect(document.getElementById(section()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Dropbox");
  });

  it("loading: a placeholder with the disconnected step's words, so the height stays, and no buttons", () => {
    show({ step: "loading" });
    expect(buttons()).toEqual([]);
    const placeholder = item().querySelector(".dropbox-placeholder")!;
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    const words = placeholder.textContent;
    show({ step: "disconnected" });
    expect(item().querySelector(".dropbox-placeholder")).toBeNull();
    expect(item().textContent).toBe(words);
  });

  it("disconnected: what it's for, and Connect Dropbox", () => {
    show({ step: "disconnected" });
    expect(item().textContent).toContain(USE);
    expect(notes()).toContain(REACH);
    expect(names()).toEqual(["Connect Dropbox"]);
    const button = buttonNamed("Connect Dropbox");
    expect(button.disabled).toBe(false);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(USE + REACH);
    click(button);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("starting: the same button, waiting for Dropbox's page to open", () => {
    show({ step: "disconnected" });
    const button = buttonNamed("Connect Dropbox");
    show({ step: "starting" });
    expect(names()).toEqual(["Opening Dropbox…"]);
    expect(buttonNamed("Opening Dropbox…")).toBe(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(item().textContent).toContain(USE);
  });

  it("waiting in the browser: says to finish there, with Cancel", () => {
    show({ step: "waiting", manual: false, submitting: false });
    expect(item().textContent).toContain("Finish on the Dropbox page that opened in your browser, then come back here.");
    expect(input("Code")).toBeNull();
    expect(names()).toEqual(["Cancel"]);
    click(buttonNamed("Cancel"));
    expect(cancelSignIn).toHaveBeenCalledTimes(1);
  });

  it("waiting for a code: pasted, then sent with Connect or with Enter", () => {
    show({ step: "waiting", manual: true, submitting: false });
    expect(item().textContent).toContain(
      "Allow access on the Dropbox page that opened in your browser, then paste the code it shows.",
    );
    const code = input("Code")!;
    expect(names()).toEqual(["Connect", "Cancel"]);
    // Nothing to send yet.
    expect(buttonNamed("Connect").disabled).toBe(true);
    key({ key: "Enter" }, code);
    type(code, "   ");
    expect(buttonNamed("Connect").disabled).toBe(true);
    key({ key: "Enter" }, code);
    expect(submitCode).not.toHaveBeenCalled();

    type(code, " sl.abc123 ");
    expect(buttonNamed("Connect").disabled).toBe(false);
    click(buttonNamed("Connect"));
    expect(submitCode).toHaveBeenLastCalledWith("sl.abc123");
    const enter = key({ key: "Enter" }, code);
    expect(enter.defaultPrevented).toBe(true);
    expect(submitCode).toHaveBeenCalledTimes(2);
    expect(submitCode).toHaveBeenLastCalledWith("sl.abc123");
    click(buttonNamed("Cancel"));
    expect(cancelSignIn).toHaveBeenCalledTimes(1);
  });

  it("a code being checked: Connecting…, Enter waits, and a code refused stays to be corrected", () => {
    show({ step: "waiting", manual: true, submitting: false });
    type(input("Code")!, "sl.wrong");
    show({ step: "waiting", manual: true, submitting: true });
    expect(names()).toEqual(["Connecting…", "Cancel"]);
    expect(buttonNamed("Connecting…").disabled).toBe(true);
    expect(buttonNamed("Connecting…").getAttribute("aria-busy")).toBe("true");
    expect(input("Code")!.readOnly).toBe(true);
    key({ key: "Enter" }, input("Code")!);
    expect(submitCode).not.toHaveBeenCalled();
    // Cancel still works while the code is checked.
    expect(buttonNamed("Cancel").disabled).toBe(false);

    show({ step: "waiting", manual: true, submitting: false }, { error: "Dropbox didn’t accept this code." });
    expect(input("Code")!.value).toBe("sl.wrong");
    expect(input("Code")!.readOnly).toBe(false);
    expect(alerts()).toEqual(["Dropbox didn’t accept this code."]);
    const alert = document.querySelector('[role="alert"]')!;
    expect(input("Code")!.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(buttonNamed("Connect").disabled).toBe(false);
  });

  it("connected: the account, its email quieter, and Disconnect", () => {
    show({ step: "connected", account: ACCOUNT, tokenInFile: false, disconnecting: false });
    expect(account()!.textContent).toBe("Connected as Ada Lovelaceada@example.com");
    expect(notes()).toContain("ada@example.com");
    expect(notes()).not.toContain(KEYRING);
    expect(names()).toEqual(["Disconnect"]);
    const button = buttonNamed("Disconnect");
    expect(button.classList.contains("btn--primary")).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBe(account()!.id);
    click(button);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("connected: says where the sign-in is kept when there is no keyring", () => {
    show({ step: "connected", account: ACCOUNT, tokenInFile: true, disconnecting: false });
    expect(notes()).toContain(KEYRING);
  });

  it("connected: an account without a name shows its email", () => {
    show({ step: "connected", account: { ...ACCOUNT, name: " " }, tokenInFile: false, disconnecting: false });
    expect(account()!.textContent).toBe("Connected as ada@example.com");
  });

  it("disconnecting: Disconnecting…, and it can't be pressed again", () => {
    show({ step: "connected", account: ACCOUNT, tokenInFile: false, disconnecting: true });
    expect(names()).toEqual(["Disconnecting…"]);
    expect(buttonNamed("Disconnecting…").disabled).toBe(true);
    expect(buttonNamed("Disconnecting…").getAttribute("aria-busy")).toBe("true");
  });

  it("shows an error as an alert, and a note as a plain note", () => {
    show({ step: "disconnected" }, { error: "Couldn’t reach Dropbox. Check your connection and try again." });
    expect(alerts()).toEqual(["Couldn’t reach Dropbox. Check your connection and try again."]);
    expect(item().contains(document.querySelector('[role="alert"]'))).toBe(true);

    const told = "Dropbox couldn’t be told. You can remove the app’s access in Dropbox’s settings.";
    show({ step: "disconnected" }, { note: told });
    expect(alerts()).toEqual([]);
    const note = [...item().querySelectorAll("p")].find((p) => p.textContent === told)!;
    expect(note.classList.contains("settings-note")).toBe(true);
    expect(note.classList.contains("inline-error")).toBe(false);
    expect(note.hasAttribute("role")).toBe(false);
  });

  it("the first read of the connection leaves focus alone", () => {
    show({ step: "loading" });
    expect(document.activeElement).toBe(dialog());
    show({ step: "disconnected" });
    expect(document.activeElement).toBe(dialog());
  });

  it("focus goes on to what comes next as the writer's steps move on", () => {
    show({ step: "disconnected" });
    act(() => buttonNamed("Connect Dropbox").focus());
    show({ step: "starting" });
    // Dropbox shows a code: focus is ready for it.
    show({ step: "waiting", manual: true, submitting: false });
    expect(document.activeElement).toBe(input("Code"));
    type(input("Code")!, "sl.abc123");
    show({ step: "waiting", manual: true, submitting: true });
    expect(document.activeElement).toBe(input("Code"));
    // Connected: the account is read out, and Tab goes on to Disconnect, Shift+Tab back to the language.
    show({ step: "connected", account: ACCOUNT, tokenInFile: false, disconnecting: false });
    expect(document.activeElement).toBe(account());
    key({ key: "Tab" });
    expect(document.activeElement).toBe(buttonNamed("Disconnect"));
    act(() => account()!.focus());
    key({ key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(select("Language"));
    // Disconnected: Connect Dropbox.
    act(() => buttonNamed("Disconnect").focus());
    show({ step: "connected", account: ACCOUNT, tokenInFile: false, disconnecting: true });
    show({ step: "disconnected" });
    expect(document.activeElement).toBe(buttonNamed("Connect Dropbox"));
    // Waiting in the browser: Cancel.
    show({ step: "starting" });
    show({ step: "waiting", manual: false, submitting: false });
    expect(document.activeElement).toBe(buttonNamed("Cancel"));
  });

  it("focus the writer moved elsewhere stays there", () => {
    show({ step: "waiting", manual: false, submitting: false });
    act(() => select("Language").focus());
    show({ step: "connected", account: ACCOUNT, tokenInFile: false, disconnecting: false });
    expect(document.activeElement).toBe(select("Language"));
  });

  describe("with useDropbox", () => {
    const status = (account: typeof ACCOUNT | null, tokenInFile = false): DropboxStatus => ({ account, tokenInFile });
    let backend: DropboxBackend;
    let dialogOpen: boolean;

    /** The workspace's part: the connection kept above the dialog, so it outlives the dialog's closing. */
    function Settings() {
      const dropbox = useDropbox(backend);
      return createElement(SettingsDialog, { ...props, open: dialogOpen, dropbox });
    }

    const showSettings = async (open = true) => {
      dialogOpen = open;
      await act(async () => root.render(createElement(Settings)));
    };
    const press = (el: HTMLElement) =>
      act(async () => {
        el.click();
      });

    beforeEach(() => {
      dialogOpen = true;
      backend = {
        status: vi.fn().mockResolvedValue(status(null)),
        signInStart: vi.fn().mockResolvedValue({ manual: true }),
        signInFinish: vi.fn().mockResolvedValue(status(ACCOUNT, true)),
        signInCancel: vi.fn().mockResolvedValue(undefined),
        signOut: vi.fn().mockResolvedValue(null),
      };
    });

    it("connects with a pasted code, survives the dialog closing, and disconnects", async () => {
      await showSettings();
      expect(names()).toEqual(["Connect Dropbox"]);
      await press(buttonNamed("Connect Dropbox"));
      expect(backend.signInStart).toHaveBeenCalledTimes(1);
      expect(input("Code")).not.toBeNull();

      // Closed and opened again: still waiting for the code.
      await showSettings(false);
      await showSettings(true);
      expect(backend.signInCancel).not.toHaveBeenCalled();
      type(input("Code")!, "sl.abc123");
      key({ key: "Enter" }, input("Code")!);
      // Dropbox's answer comes back.
      await act(async () => undefined);
      expect(backend.signInFinish).toHaveBeenCalledWith("sl.abc123");
      expect(account()!.textContent).toBe("Connected as Ada Lovelaceada@example.com");
      expect(notes()).toContain(KEYRING);

      await press(buttonNamed("Disconnect"));
      expect(backend.signOut).toHaveBeenCalledTimes(1);
      expect(names()).toEqual(["Connect Dropbox"]);
    });
  });
});
