import { useCallback, useEffect, useLayoutEffect } from "react";
import { useViewSettings } from "./core/settings";
import { useProject } from "./core/useProject";
import { BACK_AGAIN, BackStack, type Leave } from "./ui/BackStack";
import { PHONE_QUERY, useMediaQuery } from "./ui/hooks";
import { ErrorScreen, LoadingScreen } from "./ui/Screens";
import { Workspace } from "./ui/Workspace";

export default function App() {
  const api = useProject();
  const [settings, update] = useViewSettings();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const { backend, mayClose } = api;

  // The theme: the system's, or the one chosen in Settings (tokens.css reads data-theme), and the window's title bar with it.
  // The page's is set before it is first drawn, so a chosen theme never starts with a flash of the system's.
  const { theme } = settings;
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    backend?.setWindowTheme?.(theme === "system" ? null : theme).catch((error: unknown) => {
      console.error("Cannot set the window's theme", error);
    });
  }, [theme, backend]);

  // Back while no project is open (it is opening, or couldn't be opened): the
  // app closes, after the same check as anywhere. The workspace has its own.
  const leave = useCallback<Leave>(
    async (nothingOpen) => {
      if ((await mayClose(BACK_AGAIN)) && nothingOpen()) await backend?.exitApp?.();
    },
    [backend, mayClose],
  );

  let screen;
  if (api.load.status === "error") {
    screen = <ErrorScreen message={api.load.message} />;
  } else if (api.load.status === "loading" || !api.project || !api.backend) {
    screen = <LoadingScreen settings={settings} isPhone={isPhone} />;
  } else {
    screen = (
      <Workspace
        api={api}
        project={api.project}
        backend={api.backend}
        settings={settings}
        update={update}
        isPhone={isPhone}
      />
    );
  }
  return (
    <BackStack backend={backend} leave={leave}>
      {screen}
    </BackStack>
  );
}
