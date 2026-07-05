import Image from "next/image";
import gubbeImg from "@/assets/gubbe.png";
import { HeroPrompt } from "./hero-prompt";

const STEPS = [
  {
    title: "Säg var och när",
    body: "Skriv sjön och tiden — eller låt gubben använda din plats. Han vet vilka sjöar som ligger var, även när kommunerna bråkar om det.",
  },
  {
    title: "Gubben snålkollar",
    body: "Väder, vind, lufttryck, ljus, vattentemperatur och vilka arter som rör sig i just det vattnet. Inga gissningar där det finns data.",
  },
  {
    title: "Raka besked",
    body: "Vilket bete, vilket djup, vilken plats och vilken tid. Som en gammal fiskare ger dem — kort och konkret.",
  },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="flex flex-col items-center px-4 pb-20 pt-14 text-center sm:pt-20">
        <div className="rounded-full border-4 border-primary/15 shadow-lg">
          <Image
            src={gubbeImg}
            alt="Fiskargubben"
            width={104}
            height={104}
            priority
            className="rounded-full"
          />
        </div>

        <p className="mt-7 text-xs font-bold uppercase tracking-[0.22em] text-destructive/80">
          Insjöfiske, väderdrivet
        </p>
        <h1 className="mt-3 max-w-2xl text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl">
          Fråga gubben innan du kastar.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-foreground/75">
          Säg var och när du ska ut. Gubben snålkollar väder, lufttryck,
          vattentemp och vilka arter som rör sig, sen säger han rakt ut hur du
          bör fiska just nu.
        </p>

        <div className="mt-8 flex w-full justify-center">
          <HeroPrompt />
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
        </div>
      </footer>
    </main>
  );
}
