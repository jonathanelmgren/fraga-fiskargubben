import type { Metadata } from "next";
import { TOS_VERSION } from "@/lib/tos-version";

export const metadata: Metadata = {
  title: "Användarvillkor · Fråga Fiskargubben",
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">
        Användarvillkor
      </h1>
      <p className="mb-10 text-sm text-muted-foreground">
        Version {TOS_VERSION} · Senast uppdaterad: 2026-07-06
      </p>

      <div className="flex flex-col gap-6 text-sm leading-7 text-foreground">
        <section>
          <h2 className="mb-2 text-lg font-medium">1. Om tjänsten</h2>
          <p>
            Fråga Fiskargubben ("tjänsten") tillhandahålls av JPE IT AB, org.nr
            559240-5855 ("vi"). Tjänsten ger fiskeråd för svenska vatten
            baserade på öppna väder- och sjödata. Svaren genereras av en
            AI-modell (Anthropic Claude) utifrån aktuellt väder, sjöinformation
            och din fråga. Tjänsten tillhandahålls i befintligt skick. Genom att
            godkänna villkoren i chatten, skapa ett konto eller använda tjänsten
            godkänner du dessa villkor.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">
            2. AI-genererade råd, inga garantier
          </h2>
          <p>
            Fiskargubbens svar är AI-genererade och kan vara felaktiga,
            ofullständiga eller inaktuella, även när de låter tvärsäkra.
            Väderdata kan vara försenad eller saknas för ett visst vatten. Råden
            är ingen garanti för fångst och ersätter inte eget omdöme. Fiske och
            vistelse vid vatten sker på egen risk: du ansvarar själv för
            säkerhet, isbedömningar, fiskekort, fredningstider och andra regler
            som gäller där du fiskar.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">3. Konton och krediter</h2>
          <p>
            Du kan ställa en första fråga utan konto. Därefter krävs ett konto,
            som ger ett antal kostnadsfria frågor ("krediter"). En kredit
            förbrukas när en ny konversation får sitt första riktiga svar.
            Betalabonnemang tecknas med JPE IT AB och betalas via betaltjänsten
            Stripe; Stripe hanterar dina kortuppgifter och vi lagrar dem aldrig
            själva. Priser anges i tjänsten vid köptillfället. Du ansvarar för
            att hålla dina inloggningsuppgifter säkra och för aktivitet som sker
            via ditt konto. Inloggning kan ske med e-post och lösenord eller via
            Google eller Microsoft.
          </p>
          <p className="mt-3">
            Betalabonnemang som anges som "obegränsade" avser normal, personlig
            användning enligt principen om skälig användning (fair use). Det
            innebär två begränsningar. Dels kan konton som under kort tid
            startar ovanligt många nya konversationer, eller som använder
            tjänsten automatiserat, begränsas tillfälligt; en sådan begränsning
            släpps löpande, normalt inom ett dygn. Dels gäller ett övre
            användningstak per prenumerationsperiod. Taket är satt väl över
            normal personlig användning. När det nås kan nya konversationer inte
            startas förrän nästa period börjar; pågående konversationer påverkas
            inte. Kontakta oss på kontakt@fragafiskargubben.se om taket inte
            räcker för dig.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">4. Tillåten användning</h2>
          <p>
            Du får inte använda tjänsten för olaglig verksamhet, för att göra
            intrång i andras rättigheter, för att försöka kringgå begränsningar
            (till exempel kreditsystemet eller registreringsskydd) eller för att
            störa tjänstens drift.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">5. Datakällor</h2>
          <p>
            Tjänsten bygger på öppna data: väderprognoser och väderobservationer
            från SMHI, sjöinformation från Lantmäteriets öppna kartdata samt
            provfiske- och vattendata från SLU (NORS, Sötebasen och
            miljödatabasen MVM). Respektive källa ansvarar inte för tjänsten och
            har inte granskat råden. Hur dina uppgifter hanteras beskrivs i
            integritetspolicyn.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">6. Ansvarsbegränsning</h2>
          <p>
            Tjänsten tillhandahålls utan garantier av något slag. Vi ansvarar
            inte för skador, förluster eller utebliven fångst som uppstår genom
            användning av tjänsten eller genom att råd följts, utöver vad som
            följer av tvingande lag.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">7. Ändringar</h2>
          <p>
            Villkoren kan komma att uppdateras. Väsentliga ändringar meddelas i
            tjänsten. Fortsatt användning efter en ändring innebär att du
            godkänner de uppdaterade villkoren.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium">8. Kontakt</h2>
          <p>Frågor om villkoren skickas till kontakt@fragafiskargubben.se.</p>
        </section>
      </div>
    </main>
  );
}
