/**
 * "Use your location" nudge, shown on the landing hero and (randomly) inside
 * the chat when the geo toggle is still off. The inline pin mirrors the
 * toggle's icon so the user recognises which button to press.
 */
export function LocationTip({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-muted-foreground ${className}`}>
      Tips: Använd din nuvarande position genom att trycka på{" "}
      <span
        aria-hidden="true"
        className="inline-flex size-3.5 translate-y-[2px] items-center justify-center"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M12 21s-7-5.4-7-11a7 7 0 1 1 14 0c0 5.6-7 11-7 11Z" />
          <circle cx="12" cy="10" r="2.5" />
        </svg>
      </span>
      <span className="sr-only">platsknappen</span> för att få ännu mer precisa
      svar.
    </p>
  );
}
