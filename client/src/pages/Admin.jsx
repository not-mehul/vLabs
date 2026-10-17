import PortalShell from '../components/PortalShell.jsx';
import ChangePassword from '../components/admin/ChangePassword.jsx';
import InstructorAccounts from '../components/admin/InstructorAccounts.jsx';

/** Admin: your own password, the instructor accounts, and adding one. */
export default function Admin() {
  return (
    <PortalShell>
      <div className="page-head">
        <h1>Admin</h1>
        <p className="muted">Your password and the instructor accounts.</p>
      </div>
      <ChangePassword />
      <InstructorAccounts />
    </PortalShell>
  );
}
