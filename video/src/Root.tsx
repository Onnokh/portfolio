import { Composition } from "remotion";
import { fetchContributions } from "../../src/DuoCard/github";
import { profile } from "../../src/profile";
import { Card, type CardProps } from "./Card";
import { SCRIPT } from "./timeline";

const FPS = 60;

export function Root() {
  return (
    <Composition
      id="Card"
      component={Card}
      fps={FPS}
      durationInFrames={Math.round(SCRIPT.end * FPS)}
      width={1080}
      height={1080}
      defaultProps={{ days: [] } satisfies CardProps}
      // The contribution graph, live, fetched once, so every frame shows the same days.
      calculateMetadata={async ({ props }) => ({
        props: { ...props, days: props.days.length > 0 ? props.days : await fetchContributions(profile.github.login) },
      })}
    />
  );
}
