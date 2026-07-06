import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://fragafiskargubben.se";
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/ask`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/termsofservice`, changeFrequency: "yearly", priority: 0.2 },
    {
      url: `${base}/privacystatement`,
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];
}
