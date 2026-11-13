import DenDenMushi from "./DenDenMushi";
import HandyTextLogo from "./HandyTextLogo";

// Snail-phone mark + "Handy" lettering, used on onboarding screens.
const HandyLogo = ({ width = 200 }: { width?: number }) => {
  const markSize = Math.round(width * 0.36);
  return (
    <div className="flex items-center gap-3">
      <DenDenMushi variant="color" width={markSize} height={markSize} />
      <HandyTextLogo width={width} />
    </div>
  );
};

export default HandyLogo;
