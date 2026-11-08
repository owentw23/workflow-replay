// Synthetic data for installation verification only.
export const registry = new Map([
  ['inventory.v1', { args: { item: 'string' }, fields: { available: 'integer' } }],
]);

const inventory = { notebooks: 12, pencils: 27 };
export async function dispatch(operation, { item }) {
  if (operation !== 'inventory.v1' || !Object.hasOwn(inventory, item)) throw new Error('Unknown demo item');
  return { data: { available: inventory[item] } };
}

export const contracts = new Map([['demo-inventory', request => {
  const match = /^How many (notebooks|pencils) are in the demo inventory\?$/i.exec(request);
  return match ? { item: match[1].toLowerCase() } : undefined;
}]]);
