import { MenuItem } from "./Popover";

/**
 * A sheet's menu, on its row in the binder and in its type's list in the
 * inspector: Edit opens its form in the inspector; Move to Trash, after a
 * gap, asks nothing first, since the binder's Trash puts the sheet back.
 */
export function SheetMenuItems({ onEdit, onTrash }: { onEdit(): void; onTrash(): void }) {
  return (
    <>
      <MenuItem noCheck onSelect={onEdit}>
        Edit
      </MenuItem>
      <div className="popover-gap" role="none" />
      <MenuItem noCheck onSelect={onTrash}>
        Move to Trash
      </MenuItem>
    </>
  );
}
