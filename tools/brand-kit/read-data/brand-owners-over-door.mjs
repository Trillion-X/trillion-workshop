// The existing list door owns list creation and merging. Removals use its same
// record identities and conditional writes; deleting a list preserves its rows.
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

export function brandOwnersOverDoor(door, { looks, mayDelete = true }) {
  const base = () => listsOverDoor(door);
  const remove = async records => {
    if (records.length) await door.write(records, { key: `brand-remove:${makeHashCodeHexFromJson(records)}` });
  };
  return { looks, mayDelete, lists: {
    find: id => base().find(id),
    read: id => base().read(id),
    async save(input) {
      if (!input.remove) return base().save(input);
      const id = `list:${input.id}`;
      const value = await door.read('list', id);
      if (value !== null) await remove([{ id, type: 'list', value: null, expected: { type: 'list', value } }]);
      return { removed: input.id };
    },
    async putRows(listId, input) {
      if (!input.remove) return base().putRows(listId, input);
      const { list } = await base().read(listId);
      const type = `record:${list.row_type}`;
      const records = [];
      for (const rowId of input.remove) {
        const id = `${type}:${rowId}`;
        const value = await door.read(type, id);
        if (value !== null) records.push({ id, type, value: null, expected: { type, value } });
      }
      await remove(records);
      return { removed: input.remove };
    },
  } };
}
