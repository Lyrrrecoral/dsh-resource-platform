export declare const name: string;
export declare const Config: unknown;
export declare class GuardBashExecutor extends import("@deepseek-ai/dsh-bash-sandbox").SandboxBashExecutor {
	static inject: string[];
	static Config: unknown;
	constructor(ctx: unknown, config?: Record<string, unknown>);
	get caps(): unknown;
	resolve(request: unknown): unknown;
}
export default GuardBashExecutor;
