import type { Item } from "./types";

export function proxied(url: string, store: string) {
  const ref = `https://${store}/`;
  return `/api/img?u=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`;
}

export function preloadItemImage(item: Item): Promise<boolean> {
  return new Promise((resolve) => {
    if (!item.img) {
      resolve(false);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = proxied(item.img, item.store);
  });
}
