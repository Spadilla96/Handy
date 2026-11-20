import DenDenMushi from "./DenDenMushi";

// Product name, not a translatable string.
const BRAND = "Handy";

// Handy mark + "Handy" lettering, used on onboarding screens.
const HandyLogo = ({ width = 200 }: { width?: number }) => {
  const markSize = Math.round(width * 0.4);
  return (
    <div className="flex items-center gap-3 text-text">
      <DenDenMushi variant="color" width={markSize} height={markSize} />
      <span
        className="font-extrabold leading-none tracking-tight"
        style={{ fontSize: Math.round(width * 0.3) }}
      >
        {BRAND}
      </span>
    </div>
  );
};

export default HandyLogo;
