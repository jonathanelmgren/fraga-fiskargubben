import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // /ask/[id] are private conversations; /admin and /api are not content.
      disallow: ["/admin", "/api/", "/ask/", "/profile", "/reset-password"],
    },
    sitemap: "https://fragafiskargubben.se/sitemap.xml",
  };
}
