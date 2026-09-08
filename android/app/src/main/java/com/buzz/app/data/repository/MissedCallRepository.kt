package com.buzz.app.data.repository

import android.content.Context
import android.content.SharedPreferences
import com.buzz.app.data.api.ApiClient
import com.buzz.app.data.model.MissedCallEvent
import com.buzz.app.data.model.SyncResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MissedCallRepository(private val context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        private const val PREFS_NAME = "buzzz_missed_call_prefs"
        private const val KEY_LAST_SYNC_TIME = "last_sync_timestamp"
        private const val KEY_SYNC_COUNT = "total_sync_count"
    }

    fun saveLastSyncTime(timestamp: Long = System.currentTimeMillis()) {
        val currentCount = getSyncCount()
        prefs.edit()
            .putLong(KEY_LAST_SYNC_TIME, timestamp)
            .putInt(KEY_SYNC_COUNT, currentCount + 1)
            .apply()
    }

    fun getLastSyncTime(): Long {
        return prefs.getLong(KEY_LAST_SYNC_TIME, 0L)
    }

    fun getSyncCount(): Int {
        return prefs.getInt(KEY_SYNC_COUNT, 0)
    }

    suspend fun syncMissedCall(event: MissedCallEvent): Result<SyncResponse> = withContext(Dispatchers.IO) {
        try {
            val service = ApiClient.getService(context)
            val response = service.syncMissedCall(event)
            if (response.isSuccessful && response.body() != null) {
                val body = response.body()!!
                saveLastSyncTime()
                Result.success(body)
            } else {
                Result.failure(Exception("Sync failed HTTP ${response.code()}: ${response.errorBody()?.string()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
