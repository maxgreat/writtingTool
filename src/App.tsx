import { useViewSettings } from "./core/settings";
import { useProject } from "./core/useProject";
import { PHONE_QUERY, useMediaQuery } from "./ui/hooks";
import { ErrorScreen, LoadingScreen } from "./ui/Screens";
import { Workspace } from "./ui/Workspace";

export default function App() {
  const api = useProject();
  const [settings, update] = useViewSettings();
  const isPhone = useMediaQuery(PHONE_QUERY);

  if (api.load.status === "error") return <ErrorScreen message={api.load.message} />;
  if (api.load.status === "loading" || !api.project || !api.backend) {
    return <LoadingScreen settings={settings} isPhone={isPhone} />;
  }
  return (
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
