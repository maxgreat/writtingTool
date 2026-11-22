import { Folder, MapPin, StickyNote, Users } from "lucide-react";

/** The icon for a sheet type; user-defined types get a folder. */
export function SheetTypeIcon({ folder }: { folder: string }) {
  if (folder === "characters") return <Users aria-hidden />;
  if (folder === "places") return <MapPin aria-hidden />;
  if (folder === "notes") return <StickyNote aria-hidden />;
  return <Folder aria-hidden />;
}
