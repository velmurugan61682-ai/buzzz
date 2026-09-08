package com.buzz.app.worker

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.buzz.app.data.model.MissedCallEvent
import com.buzz.app.data.repository.AuthRepository
import com.buzz.app.data.repository.MissedCallRepository
import java.util.concurrent.TimeUnit

class MissedCallSyncWorker(
    private val appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "MissedCallSyncWorker"

        const val KEY_PHONE_NUMBER = "phone_number"
        const val KEY_CONTACT_NAME = "contact_name"
        const val KEY_CONTACT_EMAIL = "contact_email"
        const val KEY_CALLED_AT = "called_at"
        const val KEY_EXTERNAL_CALL_ID = "external_call_id"

        fun enqueueSync(
            context: Context,
            phoneNumber: String,
            contactName: String,
            email: String?,
            calledAtIso: String,
            externalCallId: String
        ) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val inputData = workDataOf(
                KEY_PHONE_NUMBER to phoneNumber,
                KEY_CONTACT_NAME to contactName,
                KEY_CONTACT_EMAIL to email,
                KEY_CALLED_AT to calledAtIso,
                KEY_EXTERNAL_CALL_ID to externalCallId
            )

            val syncRequest = OneTimeWorkRequestBuilder<MissedCallSyncWorker>()
                .setConstraints(constraints)
                .setInputData(inputData)
                .setBackoffCriteria(
                    androidx.work.BackoffPolicy.EXPONENTIAL,
                    30,
                    TimeUnit.SECONDS
                )
                .build()

            WorkManager.getInstance(context).enqueue(syncRequest)
            Log.d(TAG, "Enqueued missed call sync WorkManager task for $externalCallId")
        }
    }

    override suspend fun doWork(): Result {
        val phoneNumber = inputData.getString(KEY_PHONE_NUMBER) ?: return Result.failure()
        val contactName = inputData.getString(KEY_CONTACT_NAME) ?: "Unknown Caller"
        val email = inputData.getString(KEY_CONTACT_EMAIL)
        val calledAtIso = inputData.getString(KEY_CALLED_AT) ?: return Result.failure()
        val externalCallId = inputData.getString(KEY_EXTERNAL_CALL_ID) ?: return Result.failure()

        val authRepo = AuthRepository(appContext)
        val missedCallRepo = MissedCallRepository(appContext)

        if (!authRepo.isLoggedIn()) {
            Log.w(TAG, "User not authenticated in app. Retrying when logged in.")
            return Result.retry()
        }

        val deviceId = authRepo.getDeviceId()

        val event = MissedCallEvent(
            phoneNumber = phoneNumber,
            contactName = contactName,
            email = email,
            callType = "MISSED",
            calledAt = calledAtIso,
            deviceId = deviceId,
            externalCallId = externalCallId
        )

        val result = missedCallRepo.syncMissedCall(event)

        return if (result.isSuccess) {
            val body = result.getOrNull()
            Log.i(TAG, "Missed call synced successfully: ${body?.message}")
            Result.success()
        } else {
            Log.e(TAG, "Failed to sync missed call $externalCallId", result.exceptionOrNull())
            if (runAttemptCount < 3) {
                Result.retry()
            } else {
                Result.failure()
            }
        }
    }
}
