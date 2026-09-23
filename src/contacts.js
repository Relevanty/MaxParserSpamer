import { Api } from "telegram";

// Delete every saved contact on the connected account, then reset the
// imported/saved-contacts cache. Returns { total, deleted }.
export async function flushAccountContacts(client, onProgress = () => {}) {
  const res = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
  const users = res && Array.isArray(res.users) ? res.users : [];
  const total = users.length;

  let deleted = 0;
  const BATCH = 100;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH); // User objects are accepted as EntityLike
    await client.invoke(new Api.contacts.DeleteContacts({ id: batch }));
    deleted += batch.length;
    onProgress({ deleted, total });
  }

  // Clear the imported-contacts cache so re-imports start clean.
  try {
    await client.invoke(new Api.contacts.ResetSaved({}));
  } catch { /* best effort */ }

  return { total, deleted };
}
