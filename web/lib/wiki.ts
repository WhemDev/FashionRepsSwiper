import type { BrandInfo, SkippedLink, WikiSection } from "./types";
import wikiData from "../../wiki_structure.json";

const sections = wikiData as WikiSection[];

export function cleanHeading(heading: string): string {
  return heading.replace(/^#+\s*/, "").trim();
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isYupoo(host: string): boolean {
  return host.toLowerCase().endsWith(".yupoo.com");
}

export function getBrands(): BrandInfo[] {
  const map = new Map<string, Set<string>>();
  for (const section of sections) {
    const heading = cleanHeading(section.heading);
    if (heading.toLowerCase() === "trusted store list") continue;
    if (!map.has(heading)) map.set(heading, new Set());
    const stores = map.get(heading)!;
    for (const link of section.links) {
      try {
        const host = new URL(link.href).hostname.toLowerCase();
        if (isYupoo(host)) stores.add(host);
      } catch {
        /* skip bad urls */
      }
    }
  }
  return [...map.entries()]
    .map(([name, stores]) => ({
      name,
      slug: slugify(name),
      storeCount: stores.size,
    }))
    .filter((b) => b.storeCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getStoresForBrand(brandName: string): string[] {
  const target = brandName.toLowerCase();
  const stores = new Set<string>();
  for (const section of sections) {
    const heading = cleanHeading(section.heading);
    if (heading.toLowerCase() !== target) continue;
    for (const link of section.links) {
      try {
        const host = new URL(link.href).hostname.toLowerCase();
        if (isYupoo(host)) stores.add(host);
      } catch {
        /* skip */
      }
    }
  }
  return [...stores].sort();
}

export function getBrandBySlug(slug: string): BrandInfo | undefined {
  return getBrands().find((b) => b.slug === slug);
}

export function getBrandNameBySlug(slug: string): string | undefined {
  return getBrandBySlug(slug)?.name;
}

export function getSkippedLinks(): SkippedLink[] {
  const out: SkippedLink[] = [];
  for (const section of sections) {
    const brand = cleanHeading(section.heading);
    if (brand.toLowerCase() === "trusted store list") continue;
    for (const link of section.links) {
      try {
        const host = new URL(link.href).hostname.toLowerCase();
        if (!isYupoo(host) && !host.includes("reddit.com")) {
          out.push({ brand, text: link.text || link.href, href: link.href });
        }
      } catch {
        /* skip */
      }
    }
  }
  return out;
}
