import { useCallback } from "react";
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
