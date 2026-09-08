package com.buzz.app.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log
import com.buzz.app.data.repository.AuthRepository
import com.buzz.app.utils.ContactMatcher
import com.buzz.app.worker.MissedCallSyncWorker
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class MissedCallReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "MissedCallReceiver"
        private var lastState = TelephonyManager.EXTRA_STATE_IDLE
        private var isIncoming = false
        private var savedNumber: String? = null
        private var callStartTime: Long = 0
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == TelephonyManager.ACTION_PHONE_STATE_CHANGED) {
            val stateStr = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
            val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)

            if (stateStr == null) return

            when (stateStr) {
                TelephonyManager.EXTRA_STATE_RINGING -> {
                    isIncoming = true
                    callStartTime = System.currentTimeMillis()
                    if (!number.isNullOrBlank()) {
                        savedNumber = number
                    }
                    Log.d(TAG, "Phone ringing from: $savedNumber")
                }
                TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                    // Call was answered - not a missed call
                    if (lastState == TelephonyManager.EXTRA_STATE_RINGING) {
                        isIncoming = false
                        Log.d(TAG, "Call answered (OFFHOOK). Not a missed call.")
                    }
                }
                TelephonyManager.EXTRA_STATE_IDLE -> {
                    // Ringing -> Idle without OFFHOOK = Missed Call!
                    if (lastState == TelephonyManager.EXTRA_STATE_RINGING && isIncoming) {
                        Log.i(TAG, "Missed call detected from $savedNumber!")
                        handleMissedCall(context, savedNumber, callStartTime)
                    }
                    isIncoming = false
                    savedNumber = null
                }
            }
            lastState = stateStr
        }
    }

    private fun handleMissedCall(context: Context, rawNumber: String?, timestampMs: Long) {
        val phoneNumber = if (!rawNumber.isNullOrBlank()) rawNumber!! else "Unknown Number"
        val timeMs = if (timestampMs > 0) timestampMs else System.currentTimeMillis()

        val resolved = ContactMatcher.resolveContactInfo(context, phoneNumber)

        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        val calledAtIso = sdf.format(Date(timeMs))

        val authRepo = AuthRepository(context)
        val deviceId = authRepo.getDeviceId()
        val cleanPhone = phoneNumber.replace("\\D".toRegex(), "")

        val externalCallId = "call_${deviceId}_${timeMs}_$cleanPhone"

        MissedCallSyncWorker.enqueueSync(
            context = context,
            phoneNumber = phoneNumber,
            contactName = resolved.displayName,
            email = resolved.email,
            calledAtIso = calledAtIso,
            externalCallId = externalCallId
        )
    }
}
