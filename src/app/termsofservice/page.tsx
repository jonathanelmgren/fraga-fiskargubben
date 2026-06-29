import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Användarvillkor — Fråga Fiskargubben",
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">
        Användarvillkor
      </h1>
      <p className="mb-10 text-sm text-muted-foreground">
        Senast uppdaterad: 2026-06-29
      </p>

      <div className="flex flex-col gap-6 text-sm leading-7 text-foreground">
        <section>
          <h2 className="mb-2 text-lg font-medium">1. Om tjänsten</h2>
          <p>
            Fråga Fiskargubben (”tjänsten”) tillhandahålls i befintligt skick.
            Genom att skapa ett konto eller använda tjänsten godkänner du dessa
            villkor.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">2. Konton</h2>
          <p>
            Du ansvarar för att hålla dina inloggningsuppgifter säkra och för
            all aktivitet som sker via ditt konto. Inloggning kan ske med e-post
            och lösenord eller via Google eller Microsoft.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">3. Tillåten användning</h2>
          <p>
            Du får inte använda tjänsten för olaglig verksamhet, för att göra
            intrång i andras rättigheter eller för att störa tjänstens drift.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">4. Ansvarsbegränsning</h2>
          <p>
            Tjänsten tillhandahålls utan garantier. Vi ansvarar inte för
            indirekta skador som uppstår genom användning av tjänsten.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">5. Ändringar</h2>
          <p>
            Villkoren kan komma att uppdateras. Fortsatt användning efter en
            ändring innebär att du godkänner de uppdaterade villkoren.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">6. Kontakt</h2>
          <p>Frågor om villkoren skickas till kontakt@fragafiskargubben.se.</p>
        </section>
      </div>
    </main>
  );
}
