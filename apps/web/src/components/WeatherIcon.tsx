import type { WeatherIconCode } from "@run-far/shared";

interface WeatherIconProps {
  code: WeatherIconCode | null | undefined;
  isDaytime?: boolean;
  className?: string;
}

// Hand-drawn line icons matching the app's stroke="currentColor" SVG idiom (see
// AssistantChat.tsx) — replaces NWS's raster clip-art with a set that shares the calendar's
// visual language and recolors correctly via `text-*` utility classes.
export function WeatherIcon({ code, isDaytime = true, className = "h-6 w-6" }: WeatherIconProps) {
  const body = renderGlyph(code ?? "clouds", isDaytime);
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

const SUN = (
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
  </>
);

const MOON = <path d="M20 14.2A8.2 8.2 0 1110 3.8a6.6 6.6 0 0010 10.4z" />;

function cloud(yOffset = 0) {
  return (
    <path
      d={`M6.5 ${16.5 + yOffset}a3.6 3.6 0 01.3-7.2 4.6 4.6 0 018.9-1.3 3.9 3.9 0 01-.4 8.5H6.5z`}
    />
  );
}

function rainDrops(count: 2 | 3, y0 = 18) {
  const xs = count === 2 ? [9, 14] : [8, 12, 16];
  return xs.map((x) => <path key={x} d={`M${x} ${y0}l-1 2.6`} />);
}

function renderGlyph(code: WeatherIconCode, isDaytime: boolean) {
  switch (code) {
    case "clear":
      return isDaytime ? SUN : MOON;
    case "few":
      return (
        <>
          <g opacity={0.7} transform="translate(-1.5,-2) scale(0.65)">
            {isDaytime ? SUN : MOON}
          </g>
          {cloud(1)}
        </>
      );
    case "clouds":
      return (
        <>
          {cloud(-2)}
          <path d="M4 20a3 3 0 01.3-6 3.8 3.8 0 017.3-1" opacity={0.6} />
        </>
      );
    case "overcast":
      return (
        <>
          {cloud(-2)}
          <path d="M3.5 20h15" />
          <path d="M3.5 17.3h13" opacity={0.5} />
        </>
      );
    case "fog":
      return (
        <>
          <path d="M5 9.5h14" opacity={0.5} />
          <path d="M3.5 13h17" />
          <path d="M5 16.5h14" opacity={0.5} />
          <path d="M7 20h10" opacity={0.7} />
        </>
      );
    case "rain":
      return (
        <>
          {cloud(-4)}
          {rainDrops(3, 16.5)}
        </>
      );
    case "showers":
      return (
        <>
          {cloud(-4)}
          {rainDrops(2, 17.5)}
        </>
      );
    case "tstorm":
      return (
        <>
          {cloud(-4)}
          <path d="M12.5 14.5l-2.5 4h2.4l-1.4 4 4-5.2h-2.4z" />
        </>
      );
    case "snow":
      return (
        <>
          {cloud(-4)}
          {[8.5, 12, 15.5].map((x) => (
            <g key={x} transform={`translate(${x} 18.5)`}>
              <path d="M0 -1.6v3.2M-1.4 -0.8l2.8 1.6M1.4 -0.8l-2.8 1.6" />
            </g>
          ))}
        </>
      );
    case "sleet":
      return (
        <>
          {cloud(-4)}
          <path d="M8.5 16.5l-1 2.6" />
          <g transform="translate(14.5 18)">
            <path d="M0 -1.6v3.2M-1.4 -0.8l2.8 1.6M1.4 -0.8l-2.8 1.6" />
          </g>
        </>
      );
    case "wind":
      return (
        <>
          <path d="M3 9h11a2.5 2.5 0 10-2.4-3.2" />
          <path d="M3 14h14.5a2.5 2.5 0 11-2.4 3.2" />
          <path d="M3 19h8" />
        </>
      );
    case "hot":
      return (
        <>
          <path d="M10.5 3.5v9.4a3.5 3.5 0 103 0V3.5a1.5 1.5 0 00-3 0z" />
          <circle cx="12" cy="17" r="1.6" fill="currentColor" stroke="none" />
        </>
      );
    case "cold":
      return (
        <>
          <path d="M12 3v18M6 7l12 10M18 7L6 17" />
        </>
      );
    default:
      return cloud(-2);
  }
}
