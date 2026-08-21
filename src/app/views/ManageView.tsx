import { CriteriaForm } from "../components/CriteriaForm";
import { SourcesTable } from "../components/SourcesTable";
import { RunNow } from "../components/RunNow";
import { ResumeCard } from "../components/ResumeCard";

export function ManageView() {
  return (
    <div className="view">
      <h1>Manage</h1>
      <RunNow />
      <ResumeCard />
      <CriteriaForm />
      <SourcesTable />
    </div>
  );
}
