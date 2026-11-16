export function FirmsAcknowledgment({ className }: { className?: string }) {
  return (
    <p className={className}>
      We acknowledge the use of data and/or imagery from NASA&apos;s Fire Information for Resource Management System
      (FIRMS) (
      <a className="underline underline-offset-2 hover:text-foreground" href="https://earthdata.nasa.gov/firms">
        https://earthdata.nasa.gov/firms
      </a>
      ), part of NASA&apos;s Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (
      <a className="underline underline-offset-2 hover:text-foreground" href="https://earthdata.nasa.gov/lance">
        https://earthdata.nasa.gov/lance
      </a>
      ) and NASA&apos;s Earth Science Data and Information System (ESDIS).
    </p>
  );
}
