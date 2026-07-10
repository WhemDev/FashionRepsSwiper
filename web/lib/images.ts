import type { Item } from "./types";

const loadedUrls = new Set<string>();

export function proxied(url: string, store: string) {
  const ref = `https://${store}/`;
  return `/api/img?u=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`;
}

export function isImageCached(item: Item): boolean {
  if (!item.img) return false;
  return loadedUrls.has(proxied(item.img, item.store));
}

export function preloadItemImage(item: Item): Promise<boolean> {
  if (!item.img) return Promise.resolve(false);

  const url = proxied(item.img, item.store);
  if (loadedUrls.has(url)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      loadedUrls.add(url);
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

export function preloadItemImages(items: Item[]): Promise<Item[]> {
  return Promise.all(
    items.map(async (item) => ((await preloadItemImage(item)) ? item : null))
  ).then((results) => results.filter((item): item is Item => item !== null));
}
