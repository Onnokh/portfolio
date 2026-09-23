import { DuoCard } from "./DuoCard/DuoCard";
import crew from "./assets/apps/crew-icon.webp";
import keepmowing from "./assets/apps/keepmowing-icon.png";
import linkedin from "./assets/apps/linkedin-icon.svg";
import missingmounts from "./assets/apps/missingmounts-icon.png";
import shadertown from "./assets/apps/shadertown-icon.png";
import sleevy from "./assets/apps/sleevy-icon.png";
import wallpaper from "./assets/wallpaper.jpg";
import x from "./assets/apps/x-icon.svg";

export function App() {
  return (
    <main className="page">
      <div className="stage">
        <DuoCard
          name="Onno Klein Hofmeijer"
          controls={new URLSearchParams(location.search).get("debug") === "true"}
          role="Developer"
          handle="@onnokh"
          avatar={{ src: "https://avatars.githubusercontent.com/u/20066446?v=4&s=320", alt: "" }}
          footnote="Tilburg, NL"
          github={{ login: "Onnokh", href: "https://github.com/Onnokh" }}
          wallpaper={wallpaper}
          apps={[
            { name: "Missing Mounts", description: "Track the World of Warcraft mounts you are still missing.", href: "https://missingmounts.com", icon: missingmounts },
            { name: "Sleevy", description: "A bookmark manager with a read-later queue and an MCP server.", href: "https://sleevy.app", icon: sleevy },
            { name: "keepmow.ing", description: "One shared lawn for everybody. Cut the grass, and it grows back.", href: "https://keepmow.ing", icon: keepmowing },
            { name: "Shadertown", description: "A catalogue of fullscreen WebGPU shaders, built on vgpu.", href: "https://www.shadertown.com", icon: shadertown },
            { name: "Crew", description: "Shared memory for teams of AI coding agents.", href: "https://use-crew.app", icon: crew },
            { name: "X", description: "@onnokh on X.", href: "https://x.com/onnokh", icon: x },
            { name: "LinkedIn", description: "Onno Klein Hofmeijer on LinkedIn.", href: "https://www.linkedin.com/in/onno-klein-hofmeijer-6b02a986/", icon: linkedin },
          ]}
        />
      </div>
    </main>
  );
}
