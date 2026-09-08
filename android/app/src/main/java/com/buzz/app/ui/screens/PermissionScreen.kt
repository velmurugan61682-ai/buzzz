package com.buzz.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.PhoneCallback
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionScreen(
    onPermissionsGranted: () -> Unit
) {
    val context = LocalContext.current

    val requiredPermissions = remember {
        arrayOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_CONTACTS
        )
    }

    var permissionStatusMap by remember {
        mutableStateOf(
            requiredPermissions.associateWith {
                ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
            }
        )
    }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        permissionStatusMap = results
        if (results.values.all { it }) {
            onPermissionsGranted()
        }
    }

    val allGranted = permissionStatusMap.values.all { it }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Required Permissions") },
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
                .padding(24.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column {
                Text(
                    text = "Companion Permissions",
                    fontSize = 24.sp,
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onBackground
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "BUZZZ requires the following permissions to detect missed calls and match caller names on device:",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f)
                )

                Spacer(modifier = Modifier.height(24.dp))

                PermissionItem(
                    icon = Icons.Default.PhoneInTalk,
                    title = "Read Phone State",
                    description = "Detects incoming calls and when a call ends without being answered.",
                    isGranted = permissionStatusMap[Manifest.permission.READ_PHONE_STATE] == true
                )

                Spacer(modifier = Modifier.height(16.dp))

                PermissionItem(
                    icon = Icons.Default.PhoneCallback,
                    title = "Read Call Log",
                    description = "Reads missed call entry details (timestamp, duration, caller number).",
                    isGranted = permissionStatusMap[Manifest.permission.READ_CALL_LOG] == true
                )

                Spacer(modifier = Modifier.height(16.dp))

                PermissionItem(
                    icon = Icons.Default.Contacts,
                    title = "Read Contacts",
                    description = "Matches caller phone number to your Android contacts to resolve caller name & email on-device.",
                    isGranted = permissionStatusMap[Manifest.permission.READ_CONTACTS] == true
                )
            }

            Button(
                onClick = {
                    if (allGranted) {
                        onPermissionsGranted()
                    } else {
                        launcher.launch(requiredPermissions)
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp)
            ) {
                Text(
                    text = if (allGranted) "Continue to Dashboard" else "Grant Permissions",
                    fontSize = 16.sp
                )
            }
        }
    }
}

@Composable
private fun PermissionItem(
    icon: ImageVector,
    title: String,
    description: String,
    isGranted: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isGranted) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = icon,
                contentDescription = title,
                tint = if (isGranted) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(32.dp)
            )
            Spacer(modifier = Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                )
            }
            if (isGranted) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Granted",
                    tint = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.size(24.dp)
                )
            }
        }
    }
}
