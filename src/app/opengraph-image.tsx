import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Fråga Fiskargubben — fiskeråd med koll på vädret";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social share card (Messenger/WhatsApp/Facebook/X). Generated at build time.
 * Colors are hex approximations of the oklch brand tokens in globals.css
 * (satori doesn't parse oklch): cream background, dark-teal text, gold accent.
 */
export default async function Image() {
  const icon = await readFile(join(process.cwd(), "src/assets/gubbe-icon.png"));

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 64,
        background: "#f2eee2",
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: satori requires plain img */}
      <img
        src={`data:image/png;base64,${icon.toString("base64")}`}
        width={280}
        height={280}
        style={{ borderRadius: 140 }}
        alt=""
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          maxWidth: 640,
        }}
      >
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            color: "#22403a",
            lineHeight: 1.1,
          }}
        >
          Fråga Fiskargubben
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 34,
            color: "#5a5546",
            lineHeight: 1.35,
          }}
        >
          Fiskeråd med koll på vädret. Fråga gubben innan du kastar.
        </div>
        <div
          style={{
            marginTop: 40,
            display: "flex",
            alignSelf: "flex-start",
            background: "#d9a13b",
            color: "#3a2f14",
            fontSize: 28,
            fontWeight: 700,
            padding: "14px 32px",
            borderRadius: 14,
          }}
        >
          fragafiskargubben.se
        </div>
      </div>
    </div>,
    size,
  );
}
