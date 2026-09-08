package com.buzz.app.utils

import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import android.util.Log

data class ResolvedContact(
    val displayName: String = "Unknown Caller",
    val email: String? = null
)

object ContactMatcher {
    private const val TAG = "ContactMatcher"

    /**
     * Resolves display name and optional linked email address for a given phone number.
     * Requires READ_CONTACTS permission. If denied or no match, returns default ResolvedContact.
     */
    fun resolveContactInfo(context: Context, phoneNumber: String?): ResolvedContact {
        if (phoneNumber.isNullOrBlank()) {
            return ResolvedContact()
        }

        var displayName = "Unknown Caller"
        var contactId: String? = null

        try {
            val uri = Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                Uri.encode(phoneNumber)
            )
            val projection = arrayOf(
                ContactsContract.PhoneLookup.DISPLAY_NAME,
                ContactsContract.PhoneLookup._ID
            )

            context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME)
                    val idIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup._ID)

                    if (nameIndex != -1) {
                        val name = cursor.getString(nameIndex)
                        if (!name.isNullOrBlank()) {
                            displayName = name
                        }
                    }

                    if (idIndex != -1) {
                        contactId = cursor.getString(idIndex)
                    }
                }
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "READ_CONTACTS permission not granted. Degraded mode fallback to Unknown Caller.")
        } catch (e: Exception) {
            Log.e(TAG, "Error resolving contact name for $phoneNumber", e)
        }

        // Search for linked email if contactId was found
        var linkedEmail: String? = null
        if (!contactId.isNullOrEmpty()) {
            try {
                val emailProjection = arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS)
                val emailSelection = "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?"
                val emailSelectionArgs = arrayOf(contactId)

                context.contentResolver.query(
                    ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                    emailProjection,
                    emailSelection,
                    emailSelectionArgs,
                    null
                )?.use { emailCursor ->
                    if (emailCursor.moveToFirst()) {
                        val emailIndex = emailCursor.getColumnIndex(ContactsContract.CommonDataKinds.Email.ADDRESS)
                        if (emailIndex != -1) {
                            linkedEmail = emailCursor.getString(emailIndex)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Error querying linked email for contact ID $contactId", e)
            }
        }

        return ResolvedContact(displayName = displayName, email = linkedEmail)
    }
}
