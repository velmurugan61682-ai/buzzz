package com.buzz.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.PhoneCallback
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.buzz.app.data.model.MissedCallEvent
import com.buzz.app.data.repository.AuthRepository
import com.buzz.app.data.repository.MissedCallRepository
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    authRepo: AuthRepository,
    missedCallRepo: MissedCallRepository,
    onLogout: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    var lastSyncTime by remember { mutableLongStateOf(missedCallRepo.getLastSyncTime()) }
    var syncCount by remember { mutableIntStateOf(missedCallRepo.getSyncCount()) }
    var isSyncing by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    val userEmail = authRepo.getUserEmail() ?: "User"
    val deviceId = authRepo.getDeviceId()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("BUZZZ Companion") },
                actions = {
                    TextButton(onClick = onLogout) {
                        Text("Logout", color = MaterialTheme.colorScheme.onPrimary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary
                )
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(20.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Column(modifier = Modifier.padding(20.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.CheckCircle,
                                contentDescription = "Active",
                                tint = MaterialTheme.colorScheme.secondary,
                                modifier = Modifier.size(28.dp)
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Column {
                                Text(
                                    text = "Sync Status: Active",
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                Text(
                                    text = "Signed in as $userEmail",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(16.dp))
                        HorizontalDivider()
                        Spacer(modifier = Modifier.height(16.dp))

                        Text(
                            text = "Device ID: $deviceId",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = "Backend Server: ${authRepo.getServerBaseUrl()}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = "Total Synced Calls: $syncCount",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary
                        )
                        Text(
                            text = if (lastSyncTime > 0) {
                                val sdf = SimpleDateFormat("MMM dd, yyyy HH:mm:ss", Locale.getDefault())
                                "Last Synced: ${sdf.format(Date(lastSyncTime))}"
                            } else {
                                "Last Synced: Never (Waiting for incoming missed call)"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(24.dp))

                Text(
                    text = "Background Missed Call Detection",
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "When an incoming call is missed on this phone, BUZZZ automatically matches the caller against your local contacts and syncs it to your web Inbox in real time.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f)
                )

                if (!statusMessage.isNull_orEmpty()) {
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = statusMessage!!,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }

            Button(
                onClick = {
                    isSyncing = true
                    statusMessage = null
                    coroutineScope.launch {
                        val nowMs = System.currentTimeMillis()
                        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                        sdf.timeZone = TimeZone.getTimeZone("UTC")
                        val calledAtIso = sdf.format(Date(nowMs))

                        val testEvent = MissedCallEvent(
                            phoneNumber = "+919876543210",
                            contactName = "John Doe (Android Test)",
                            email = "john.doe@example.com",
                            callType = "MISSED",
                            calledAt = calledAtIso,
                            deviceId = deviceId,
                            externalCallId = "manual_test_${deviceId}_${nowMs}"
                        )

                        val res = missedCallRepo.syncMissedCall(testEvent)
                        isSyncing = false
                        if (res.isSuccess) {
                            lastSyncTime = missedCallRepo.getLastSyncTime()
                            syncCount = missedCallRepo.getSyncCount()
                            statusMessage = "✅ Test missed call synced successfully to BUZZZ Inbox!"
                        } else {
                            statusMessage = "❌ Sync error: ${res.exceptionOrNull()?.message}"
                        }
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
                enabled = !isSyncing
            ) {
                if (isSyncing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                } else {
                    Icon(imageVector = Icons.Default.Refresh, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Trigger Test Missed Call Sync", fontSize = 16.sp)
                }
            }
        }
    }
}

private fun String?.isNull_orEmpty(): Boolean = this == null || this.trim().isEmpty()
