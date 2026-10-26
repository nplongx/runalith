/** Deterministic JSON serialization for integrity identities over JSON values. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('Canonical JSON only supports finite numbers other than negative zero');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === 'symbol') || keys.length !== value.length + 1 || Object.keys(value).length !== value.length ||
        Object.keys(value).some((key, index) => key !== String(index))) {
      throw new TypeError('Canonical JSON does not support sparse arrays, symbol keys, or extra array properties');
    }
    const values = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Canonical JSON does not support array accessors');
      values.push(canonicalJson(descriptor.value));
    }
    return `[${values.join(',')}]`;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Canonical JSON only supports plain JSON objects and arrays');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) throw new TypeError('Canonical JSON does not support symbol keys');
  const keys = ownKeys.sort();
  return `{${keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Canonical JSON does not support non-enumerable properties or accessors');
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
  }).join(',')}}`;
}
