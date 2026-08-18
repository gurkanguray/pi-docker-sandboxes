export interface SandboxImageAttestation {
	status: "pending" | "verified";
	image: string;
	templateStoreId?: string;
}

export interface SandboxState {
	version: 1;
	name: string;
	hostBaseCommit: string;
	hostBranch: string;
	hostRepoIdentity: string;
	hostRoot: string;
	workspaceMode: "clone";
	createdAt: string;
	imageAttestation?: SandboxImageAttestation;
}
