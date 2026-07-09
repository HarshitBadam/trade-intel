export default function ColorPalette() {
    const colors = [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "primary",
      "secondary",
      "accent",
      "muted",
      "muted-foreground",
      "border",
      "input",
      "ring",
      "sidebar",
      "sidebar-accent",
      "sidebar-accent-foreground",
    ];
  
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6">
        {colors.map((color) => (
          <div key={color} className="flex flex-col items-center gap-2">
            <div
              className={`w-full h-24 rounded-xl border`}
              style={{ backgroundColor: `var(--${color})` }}
            ></div>
            <span className="text-xs text-center">{color}</span>
          </div>
        ))}
      </div>
    );
  }
  