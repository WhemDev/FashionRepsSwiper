export type Item = {
  id: string;
  title: string;
  brand: string;
  store: string;
  url: string;
  img: string;
};

export type WikiLink = { text: string; href: string };
export type WikiSection = {
  heading: string;
  level: string;
  links: WikiLink[];
};

export type BrandInfo = {
  name: string;
  slug: string;
  storeCount: number;
};

export type SkippedLink = {
  brand: string;
  text: string;
  href: string;
};

export type ScrapeMeta = {
  queries: string[];
  categories: string[];
};
