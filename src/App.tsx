import { DuoCard } from "./DuoCard/DuoCard";
import { profile } from "./profile";

export function App() {
  return (
    <main className="page">
      <div className="stage">
        <DuoCard {...profile} controls={new URLSearchParams(location.search).get("debug") === "true"} />
      </div>
    </main>
  );
}
