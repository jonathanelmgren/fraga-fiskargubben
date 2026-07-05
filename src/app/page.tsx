import { cookies } from "next/headers";
import Image from "next/image";
import { connection } from "next/server";
import gubbeImg from "@/assets/gubbe.png";
import { SHARE_LOCATION_COOKIE } from "@/lib/prefs-cookies";
import { HeroPrompt } from "./hero-prompt";
import { pickHeroSuggestions } from "./hero-suggestions";

const STEPS = [
  {
    title: "Säg var och när",
    body: "Skriv sjön och tiden, eller låt gubben använda din plats. Han vet vilka sjöar som ligger var, även när kommunerna bråkar om det.",
  },
  {
    title: "Gubben kollar läget",
    body: "Väder, vind, lufttryck, ljus, vattentemperatur och vilka arter som rör sig i just det vattnet. Inga gissningar där det finns data.",
  },
  {
    title: "Raka besked",
    body: "Vilket bete, vilket djup, vilken plats och vilken tid. Kort och konkret, som en gammal fiskare ger dem.",
  },
];

export default async function Home() {
  // Render at request time so the suggestion chips rotate per visit and the
  // geo toggle reflects the preference cookie. No hydration flash either way.
  await connection();
  const suggestions = pickHeroSuggestions();
  const cookieStore = await cookies();
  const shareLocation = cookieStore.get(SHARE_LOCATION_COOKIE)?.value === "1";

  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-2 px-4 pb-20 pt-10 sm:flex-row sm:items-center sm:justify-center sm:gap-12 sm:pt-16">
        <Image
          src={gubbeImg}
          alt="Fiskargubben"
          priority
          className="h-36 w-auto sm:order-2 sm:h-80"
        />

        <div className="flex max-w-xl flex-col items-center text-center sm:order-1 sm:items-start sm:text-left">
          <p className="mt-4 text-xs font-bold uppercase tracking-[0.22em] text-destructive/80 sm:mt-0">
            Fiskeråd med koll på vädret
          </p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl">
            Fråga gubben innan du kastar.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-foreground/75">
            Säg var och när du ska ut. Gubben kollar väder, lufttryck,
            vattentemp och vilka arter som rör sig, sen säger han rakt ut hur du
            bör fiska just nu. Sjö, kust eller skärgård, fråga på.
          </p>

          <div className="mt-8 w-full">
            <HeroPrompt
              suggestions={suggestions}
              initialShareLocation={shareLocation}
            />
          </div>
        </div>
      </section>

      {/* Så funkar det */}
      <section
        id="sa-funkar-det"
        className="border-t border-border bg-card/50 px-4 py-16"
      >
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-2xl font-bold tracking-tight">
            Så funkar det
          </h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <div key={step.title} className="text-center sm:text-left">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <h3 className="mt-3 text-base font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Wave footer decoration */}
      <footer className="mt-auto">
        <svg
          viewBox="0 0 1440 80"
          preserveAspectRatio="none"
          className="block h-14 w-full text-primary/15"
          aria-hidden="true"
        >
          <path
            d="M0,40 C240,80 480,0 720,40 C960,80 1200,0 1440,40 L1440,80 L0,80 Z"
            fill="currentColor"
          />
        </svg>
        <div className="bg-primary/15 pb-6 text-center text-xs text-muted-foreground">
          <a href="/termsofservice" className="underline underline-offset-2">
            Villkor
          </a>
          <span className="mx-2">·</span>
          <a href="/privacystatement" className="underline underline-offset-2">
            Integritet
          </a>
          {process.env.NEXT_PUBLIC_DISCORD_INVITE && (
            <>
              <span className="mx-2">·</span>
              <a
                href={process.env.NEXT_PUBLIC_DISCORD_INVITE}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Support
              </a>
            </>
          )}
        </div>
      </footer>
    </main>
  );
}
