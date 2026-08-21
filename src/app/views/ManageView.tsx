import { CriteriaForm } from "../components/CriteriaForm";
import { SourcesTable } from "../components/SourcesTable";
import { RunNow } from "../components/RunNow";
import { ResumeCard } from "../components/ResumeCard";
import type { UseAdminToken } from "../hooks/useAdminToken";

interface ManageViewProps {
  adminToken: UseAdminToken;
}

export function ManageView({ adminToken }: ManageViewProps) {
  return (
    <div className="view">
      <div className="manage-header">
        <h1>Manage</h1>
        <div className="token-indicator">
          <span>
            {adminToken.token
              ? "token set for this session"
              : "you'll be prompted on first save"}
          </span>
          {adminToken.token && (
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={adminToken.clearToken}
            >
              Forget token
            </button>
          )}
        </div>
      </div>
      <RunNow adminToken={adminToken} />
      <ResumeCard adminToken={adminToken} />
      <CriteriaForm adminToken={adminToken} />
      <SourcesTable adminToken={adminToken} />
    </div>
  );
}
