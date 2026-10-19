import { pool } from "@workspace/db";

function isMissingResetColumn(error: unknown): boolean {
  return !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "42703";
}

export async function passwordChangeRequired(userId: string): Promise<boolean> {
  try {
    const result = await pool.query<{ required: boolean }>(
      `SELECT password_change_required AS required
       FROM public.petro_profiles
       WHERE user_id = $1::uuid`,
      [userId],
    );
    return result.rows[0]?.required === true;
  } catch (error) {
    if (isMissingResetColumn(error)) return false;
    throw error;
  }
}

export async function clearPasswordChangeRequired(userId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE public.petro_profiles
       SET password_change_required = false
       WHERE user_id = $1::uuid`,
      [userId],
    );
  } catch (error) {
    if (isMissingResetColumn(error)) return;
    throw error;
  }
}
