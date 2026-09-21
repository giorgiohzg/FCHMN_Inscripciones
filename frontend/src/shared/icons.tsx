import type { SVGProps } from "react";

/** Íconos de trazo simple (24x24), pensados para el menú lateral — sin depender de ninguna librería externa. */
function Icon(props: SVGProps<SVGSVGElement>) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props} />;
}

export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9" />
      <path d="M9.5 20v-6h5v6" />
    </Icon>
  );
}

export function PersonsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17.5" cy="9" r="2.3" />
      <path d="M15.5 14.2c2.6.4 4.5 2.6 4.5 5.3" />
    </Icon>
  );
}

export function ClubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 21V10l8-6 8 6v11" />
      <path d="M4 21h16" />
      <path d="M10 21v-6h4v6" />
      <path d="M9 12h.01M15 12h.01M12 9h.01" />
    </Icon>
  );
}

export function SwimmerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="18.5" cy="6" r="1.6" />
      <path d="M4 12.5c1.6 1.4 3 1.4 4.6 0s3-1.4 4.6 0 3 1.4 4.6 0 3-1.4 4.6 0" />
      <path d="M4 17c1.6 1.4 3 1.4 4.6 0s3-1.4 4.6 0 3 1.4 4.6 0 3-1.4 4.6 0" />
      <path d="M9 12 14 8l3 2" />
    </Icon>
  );
}

export function CatalogIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </Icon>
  );
}

export function CompetitionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M8 4h8v4a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4" />
      <path d="M12 13v3M9 20h6M10 16.5h4l.6 3.5H9.4l.6-3.5Z" />
    </Icon>
  );
}

export function RegistrationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
      <path d="M9 3.5V6h6V3.5" />
      <path d="m8.5 13 2 2 4-4" />
    </Icon>
  );
}

export function RelayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 6h8M6 8v8M18 8v8M8 18h8" />
    </Icon>
  );
}

export function ReportsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M4 20h16" />
    </Icon>
  );
}

export function AuditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 19 6.5v5.3c0 4.3-3 7.6-7 8.7-4-1.1-7-4.4-7-8.7V6.5l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function CollapseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      <path d="M9.5 4v16" />
      <path d="m14.5 9-2.5 3 2.5 3" />
    </Icon>
  );
}
