import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asana configuration
const ASANA_TOKEN =
  '2/1207610480896330/1212689586165502:979afeddc93c9825272afec2a36ba283';
const ASANA_WORKSPACE = '1212687373718997';
const ASANA_PROJECT = '1212687378578807';

// Asana Custom Field GIDs - Will be automatically populated on server start
const ASANA_CUSTOM_FIELDS = {
  WALLET: null,
  PAYMENT_GATEWAY: null,
  TRANSACTION_ID: null,
  AMOUNT: null,
  AGENT_REMARK: null,
  INTERCOM_CONVERSATION_ID: null, // For webhook sync back to Intercom
};

// Cache for custom field mappings
let customFieldsCache = null;

// Intercom configuration
const INTERCOM_TOKEN =
  'dG9rOmQxMmIxYTQxXzcwMDhfNGE2Ml9iODU1XzQ5MjFkNjA4NWRlZDoxOjA=';

// Asana webhook secret (will be set during webhook handshake)
let asanaWebhookSecret = null;

// Map to store Asana task ID to Intercom conversation ID
const asanaTaskToConversation = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes a button to create an Asana task for the contact.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'header',
          text: 'Create Asana Task for Ticket',
          align: 'center',
          style: 'header',
        },
        {
          type: 'button',
          label: 'Create Asana Task',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Helper function to get contact name from Intercom API
async function getContactName(contactId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/contacts/${contactId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.name || 'Unknown Contact';
    }
    return 'Unknown Contact';
  } catch (error) {
    console.error('Error fetching contact from Intercom:', error);
    return 'Unknown Contact';
  }
}

// Helper function to get conversation details from Intercom API
async function getConversation(conversationId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching conversation from Intercom:', error);
    return null;
  }
}

// Helper function to get ticket details from Intercom Tickets API
async function getTicket(ticketId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching ticket from Intercom:', error);
    return null;
  }
}

// Helper function to find attachment URL by ID from Intercom conversation
function findAttachmentUrlById(conversation, attachmentId) {
  console.log('Searching for attachment with ID:', attachmentId);

  const allAttachments = [];

  // Check the main conversation source for attachments
  if (
    conversation.source &&
    conversation.source.attachments &&
    Array.isArray(conversation.source.attachments)
  ) {
    allAttachments.push(...conversation.source.attachments);
  }

  // Check each conversation part for attachments
  if (
    conversation.conversation_parts &&
    conversation.conversation_parts.conversation_parts &&
    Array.isArray(conversation.conversation_parts.conversation_parts)
  ) {
    conversation.conversation_parts.conversation_parts.forEach((part) => {
      if (part.attachments && Array.isArray(part.attachments)) {
        allAttachments.push(...part.attachments);
      }
    });
  }

  console.log(
    `Total attachments found in conversation: ${allAttachments.length}`
  );

  // Try to find attachment by matching the ID in the URL
  for (const attachment of allAttachments) {
    console.log(
      'Checking attachment:',
      attachment.name,
      'URL:',
      attachment.url
    );

    // Check if the attachment ID appears in the URL
    if (attachment.url && attachment.url.includes(String(attachmentId))) {
      console.log('✓ Found matching attachment!');
      console.log('  Name:', attachment.name);
      console.log('  URL:', attachment.url);
      console.log('  Content Type:', attachment.content_type);
      return attachment.url;
    }
  }

  console.log('✗ No attachment found with ID:', attachmentId);
  return null;
}

// Helper function to update Intercom ticket attributes
async function updateTicketAttribute(ticketId, asanaTaskId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_attributes: {
            AsanaTaskID: asanaTaskId,
          },
        }),
      }
    );

    if (response.ok) {
      console.log('Successfully updated ticket with Asana task ID');
      return true;
    } else {
      const errorData = await response.json();
      console.error('Error updating ticket:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating ticket attribute:', error);
    return false;
  }
}

// Helper function to update Intercom ticket Asana Status field
async function updateTicketAsanaStatus(ticketId, status) {
  try {
    console.log(`Updating ticket ${ticketId} Asana Status to: "${status}"`);

    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_attributes: {
            'Asana Status': status,
          },
        }),
      }
    );

    if (response.ok) {
      console.log(`✓ Successfully updated Asana Status to "${status}"`);
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating Asana Status:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating Asana Status:', error);
    return false;
  }
}

// Helper function to update Intercom ticket state ID based on Asana completion status
async function updateTicketStateId(ticketId, isCompleted) {
  try {
    const stateId = isCompleted ? '3480795' : '3480792';
    console.log(
      `Updating ticket ${ticketId} ticket_state_id to: "${stateId}" (completed: ${isCompleted})`
    );

    const response = await fetch(
      `https://api.intercom.io/tickets/${ticketId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ticket_state_id: stateId,
        }),
      }
    );

    if (response.ok) {
      console.log(`✓ Successfully updated ticket_state_id to "${stateId}"`);
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating ticket_state_id:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating ticket_state_id:', error);
    return false;
  }
}

// Helper function to get custom field settings for a project
async function getAsanaCustomFields() {
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/projects/${ASANA_PROJECT}/custom_field_settings`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    return null;
  }
}

// Helper function to initialize custom field mappings
async function initializeCustomFieldMappings() {
  try {
    console.log('Fetching Asana custom field mappings...');
    const customFieldSettings = await getAsanaCustomFields();

    if (!customFieldSettings || customFieldSettings.length === 0) {
      console.warn('⚠ No custom fields found in Asana project');
      console.warn(
        'Custom field syncing will be disabled. Please add custom fields to your Asana project.'
      );
      return null;
    }

    const mappings = {};
    const fieldNames = {
      Wallet: 'WALLET',
      'Payment Gateway': 'PAYMENT_GATEWAY',
      'Transaction ID': 'TRANSACTION_ID',
      Amount: 'AMOUNT',
      'Agent Remark': 'AGENT_REMARK',
      'Intercom Conversation ID': 'INTERCOM_CONVERSATION_ID',
    };

    // Map custom field names to their GIDs
    customFieldSettings.forEach((setting) => {
      const fieldName = setting.custom_field.name;
      const fieldGid = setting.custom_field.gid;

      if (fieldNames[fieldName]) {
        const mappingKey = fieldNames[fieldName];
        mappings[mappingKey] = fieldGid;
        console.log(`✓ Mapped "${fieldName}" → ${fieldGid}`);
      }
    });

    // Update the global ASANA_CUSTOM_FIELDS object
    Object.keys(mappings).forEach((key) => {
      ASANA_CUSTOM_FIELDS[key] = mappings[key];
    });

    // Check which fields are missing
    const missingFields = Object.keys(fieldNames).filter(
      (name) => !mappings[fieldNames[name]]
    );

    if (missingFields.length > 0) {
      console.warn(
        '⚠ Missing custom fields in Asana project:',
        missingFields.join(', ')
      );
      console.warn(
        'Please create these fields in your Asana project for full syncing.'
      );
    } else {
      console.log('✓ All custom fields mapped successfully');
    }

    customFieldsCache = mappings;
    return mappings;
  } catch (error) {
    console.error('Error initializing custom field mappings:', error);
    return null;
  }
}

// Helper function to validate if string is a valid URL
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Helper function to upload attachment to Asana task
async function uploadAttachmentToAsana(taskId, attachmentUrl) {
  try {
    // Validate if it's a proper URL
    if (!isValidUrl(attachmentUrl)) {
      console.error('Invalid attachment URL:', attachmentUrl);
      console.log(
        'The attachment field appears to be an ID or invalid URL. Please provide a full URL.'
      );
      return null;
    }

    // Download the file from the attachment URL
    console.log('===== ATTACHMENT DOWNLOAD PROCESS =====');
    console.log('Full attachment URL:', attachmentUrl);
    console.log('Attempting to download...');

    const fileResponse = await fetch(attachmentUrl);

    if (!fileResponse.ok) {
      console.error(
        'Failed to download attachment. Status:',
        fileResponse.status
      );
      console.error('Status Text:', fileResponse.statusText);
      return null;
    }

    console.log('✓ Successfully downloaded attachment');
    console.log('Content-Type:', fileResponse.headers.get('content-type'));
    console.log('Content-Length:', fileResponse.headers.get('content-length'));

    // Get the file buffer and content type
    const fileBuffer = await fileResponse.buffer();
    const contentType =
      fileResponse.headers.get('content-type') || 'application/octet-stream';

    // Extract filename from URL or use a default
    const urlParts = attachmentUrl.split('/');
    const fileName =
      urlParts[urlParts.length - 1].split('?')[0] || 'attachment';

    // Create form data for multipart upload
    const formData = new FormData();
    formData.append('parent', taskId);
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: contentType,
    });

    // Upload to Asana
    console.log('===== ASANA UPLOAD PROCESS =====');
    console.log('Uploading to Asana task ID:', taskId);
    console.log('File name:', fileName);
    console.log('Content type:', contentType);
    console.log('File size:', fileBuffer.length, 'bytes');

    const asanaResponse = await fetch(
      'https://app.asana.com/api/1.0/attachments',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    if (asanaResponse.ok) {
      const asanaData = await asanaResponse.json();
      const permanentUrl =
        asanaData.data?.permanent_url ||
        asanaData.data?.download_url ||
        asanaData.data?.url ||
        'uploaded'; // Return a truthy value even if URL is missing
      console.log('✓ Successfully uploaded attachment to Asana');
      console.log('Asana response:', JSON.stringify(asanaData, null, 2));
      if (permanentUrl && permanentUrl !== 'uploaded') {
        console.log('Asana permanent URL:', permanentUrl);
      } else {
        console.log('Note: No permanent URL in response, but upload succeeded');
      }
      console.log('======================================');
      return permanentUrl;
    } else {
      const errorData = await asanaResponse
        .json()
        .catch(() => ({ error: 'Unknown error' }));
      console.error('✗ Error uploading attachment to Asana:', errorData);
      console.error(
        'Response status:',
        asanaResponse.status,
        asanaResponse.statusText
      );
      console.error('======================================');
      return null;
    }
  } catch (error) {
    console.error('Error in uploadAttachmentToAsana:', error);
    return null;
  }
}

// Root route - serves the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper endpoint to get custom field GIDs and current mappings
app.get('/asana-custom-fields', async (req, res) => {
  try {
    const customFieldSettings = await getAsanaCustomFields();

    if (customFieldSettings) {
      const fields = customFieldSettings.map((setting) => ({
        name: setting.custom_field.name,
        gid: setting.custom_field.gid,
        type: setting.custom_field.resource_type,
        description: setting.custom_field.description,
      }));

      res.json({
        success: true,
        project_id: ASANA_PROJECT,
        all_custom_fields: fields,
        mapped_fields: {
          WALLET: ASANA_CUSTOM_FIELDS.WALLET,
          PAYMENT_GATEWAY: ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY,
          TRANSACTION_ID: ASANA_CUSTOM_FIELDS.TRANSACTION_ID,
          AMOUNT: ASANA_CUSTOM_FIELDS.AMOUNT,
          AGENT_REMARK: ASANA_CUSTOM_FIELDS.AGENT_REMARK,
          INTERCOM_CONVERSATION_ID:
            ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID,
        },
        message:
          'Custom fields are automatically mapped on server start. Check mapped_fields to see current mappings.',
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to fetch custom fields from Asana',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Helper endpoint to view webhook setup information
app.get('/webhook-info', (req, res) => {
  const webhookUrl = `${req.protocol}://${req.get('host')}/asana-webhook`;

  res.json({
    success: true,
    webhook_url: webhookUrl,
    webhook_secret_stored: asanaWebhookSecret ? true : false,
    project_gid: ASANA_PROJECT,
    setup_instructions: {
      step1:
        'Make sure this server is publicly accessible (use ngrok for local development)',
      step2: `Create webhook using: POST https://app.asana.com/api/1.0/webhooks`,
      step3: 'Set resource to your project GID',
      step4: `Set target to: ${webhookUrl}`,
      step5: 'The handshake will be completed automatically',
    },
    curl_example: `curl -X POST https://app.asana.com/api/1.0/webhooks \\
  -H "Authorization: Bearer ${ASANA_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": {
      "resource": "${ASANA_PROJECT}",
      "target": "${webhookUrl}"
    }
  }'`,
    task_to_conversation_mappings: asanaTaskToConversation.size,
  });
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', async (req, res) => {
  console.log('Initialize endpoint hit');
  console.log('Initialize request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const ticketId = conversation?.ticket?.id;

    if (ticketId) {
      const ticket = await getTicket(ticketId);
      const asanaTaskId = ticket?.ticket_attributes?.AsanaTaskID;

      if (asanaTaskId) {
        // Ticket already has an Asana task, show completed state
        const completedCanvas = {
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  id: 'success',
                  text: '✓ Asana Task Already Created',
                  align: 'center',
                  style: 'header',
                },
                {
                  type: 'text',
                  id: 'task_id',
                  text: `Task ID: ${asanaTaskId}`,
                  align: 'center',
                  style: 'paragraph',
                },
                {
                  type: 'text',
                  id: 'info',
                  text: 'This ticket already has an Asana task associated with it.',
                  align: 'center',
                  style: 'paragraph',
                },
              ],
            },
          },
        };
        return res.send(completedCanvas);
      }
    }
  }

  // No existing task, show create button
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.
  This endpoint creates an Asana task with the contact's name and prevents
  duplicate submissions per conversation.
*/
app.post('/submit', async (req, res) => {
  console.log('Submit endpoint hit with component_id:', req.body.component_id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const ticketId = conversation?.ticket?.id;

    if (ticketId) {
      const ticket = await getTicket(ticketId);
      const existingTaskId = ticket?.ticket_attributes?.AsanaTaskID;

      if (existingTaskId) {
        const alreadySubmittedCanvas = {
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  id: 'already_submitted',
                  text: 'Task already created for this ticket',
                  align: 'center',
                  style: 'header',
                },
                {
                  type: 'text',
                  id: 'task_id',
                  text: `Task ID: ${existingTaskId}`,
                  align: 'center',
                  style: 'paragraph',
                },
                {
                  type: 'text',
                  id: 'info',
                  text: 'You can only create one Asana task per ticket.',
                  align: 'center',
                  style: 'paragraph',
                },
              ],
            },
          },
        };
        return res.send(alreadySubmittedCanvas);
      }
    }
  }

  if (req.body.component_id === 'submit_button') {
    try {
      // Extract contact name from Intercom data
      let contactName =
        req.body.contact?.name || req.body.customer?.name || null;

      // If no name in request body, fetch from Intercom API
      if (!contactName) {
        const contactId = req.body.contact?.id || req.body.customer?.id;
        if (contactId) {
          contactName = await getContactName(contactId);
        } else {
          contactName = 'Unknown Contact';
        }
      }

      // Get full conversation details to get ticket ID
      const fullConversation = await getConversation(conversationId);
      const ticketId = fullConversation?.ticket?.id;

      if (!ticketId) {
        throw new Error('No ticket found for this conversation');
      }

      // Get ticket details to access ticket attributes
      const ticket = await getTicket(ticketId);
      if (!ticket) {
        throw new Error('Failed to fetch ticket details');
      }

      const ticketAttrs = ticket?.ticket_attributes || {};

      // Extract the 5 custom fields from ticket attributes
      const wallet = ticketAttrs.Wallet || '';
      const paymentGateway = ticketAttrs['Payment Gateway'] || '';
      const transactionID = ticketAttrs['Transaction ID'] || '';
      const amount = ticketAttrs.Amount || '';
      const agentRemark = ticketAttrs['Agent Remark'] || '';

      // Handle attachments from ticket attributes
      // Ticket attachment format: array of objects with url property
      let attachmentFieldValue =
        ticketAttrs.Attachment || ticketAttrs.attachment; // Support both formats
      let attachmentUrls = [];

      console.log('\n===== ATTACHMENT PROCESSING FROM TICKET =====');
      console.log(
        'Attachment field raw value:',
        JSON.stringify(attachmentFieldValue)
      );
      console.log('Attachment field type:', typeof attachmentFieldValue);
      console.log('Is array:', Array.isArray(attachmentFieldValue));

      // Handle ticket attachment format (array of objects with url)
      if (
        Array.isArray(attachmentFieldValue) &&
        attachmentFieldValue.length > 0
      ) {
        // Process all attachments in the array
        console.log(
          `Found ${attachmentFieldValue.length} attachment(s) to process`
        );
        for (let i = 0; i < attachmentFieldValue.length; i++) {
          const attachment = attachmentFieldValue[i];
          if (attachment && attachment.url) {
            attachmentUrls.push(attachment.url);
            console.log(`✓ Attachment ${i + 1}:`, attachment.url);
            console.log('  Name:', attachment.name);
            console.log('  Content Type:', attachment.content_type);
          } else {
            console.log(`⚠ Attachment ${i + 1} missing URL property`);
          }
        }
      } else if (attachmentFieldValue) {
        // Handle legacy format (single URL string or single object)
        if (
          typeof attachmentFieldValue === 'object' &&
          attachmentFieldValue.url
        ) {
          attachmentUrls.push(attachmentFieldValue.url);
          console.log('✓ Found single attachment object with URL');
        } else if (isValidUrl(String(attachmentFieldValue))) {
          attachmentUrls.push(String(attachmentFieldValue));
          console.log('✓ Attachment field contains URL string');
        } else {
          console.log('⚠ Attachment field is not a valid URL or array');
        }
      } else {
        console.log('No attachment in ticket attributes');
      }

      if (attachmentUrls.length > 0) {
        console.log(
          `Final attachment URLs to use (${attachmentUrls.length}):`,
          attachmentUrls
        );
      } else {
        console.log('No attachments to process for this task');
      }
      console.log('==================================================\n');

      // Build basic task notes
      const taskNotes = `Task created from Intercom conversation ${conversationId}

Contact Information:
- Name: ${contactName}
- Email: ${req.body.contact?.email || req.body.customer?.email || 'N/A'}`;

      // Ensure custom fields are initialized (fallback if server start failed)
      if (!customFieldsCache) {
        console.log('Custom fields not initialized, initializing now...');
        await initializeCustomFieldMappings();
      }

      // Build custom fields object for Asana
      // All values must be converted to strings for Asana API
      const customFields = {};

      if (ASANA_CUSTOM_FIELDS.WALLET && wallet) {
        customFields[ASANA_CUSTOM_FIELDS.WALLET] = String(wallet);
      }
      if (ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY && paymentGateway) {
        customFields[ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY] =
          String(paymentGateway);
      }
      if (ASANA_CUSTOM_FIELDS.TRANSACTION_ID && transactionID) {
        customFields[ASANA_CUSTOM_FIELDS.TRANSACTION_ID] =
          String(transactionID);
      }
      if (ASANA_CUSTOM_FIELDS.AMOUNT && amount) {
        customFields[ASANA_CUSTOM_FIELDS.AMOUNT] = String(amount);
      }
      if (ASANA_CUSTOM_FIELDS.AGENT_REMARK && agentRemark) {
        customFields[ASANA_CUSTOM_FIELDS.AGENT_REMARK] = String(agentRemark);
      }
      // Add Intercom conversation ID for webhook sync
      if (ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID && conversationId) {
        customFields[ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID] =
          String(conversationId);
        console.log(
          'Adding conversation ID to Asana custom field:',
          conversationId
        );
      }

      console.log('Custom fields to sync:', Object.keys(customFields).length);
      if (Object.keys(customFields).length > 0) {
        console.log('Custom field values (as strings):', customFields);
      }

      // Create task payload
      const taskPayload = {
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT],
        name: contactName,
        notes: taskNotes,
      };

      // Only add custom_fields if we have any configured
      if (Object.keys(customFields).length > 0) {
        taskPayload.custom_fields = customFields;
      }

      console.log(
        'Creating Asana task with payload:',
        JSON.stringify(taskPayload, null, 2)
      );

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: taskPayload,
        }),
      });

      const asanaData = await asanaResponse.json();

      if (asanaResponse.ok) {
        const asanaTaskId = asanaData.data.gid;

        // Upload all attachments to Asana if available
        let attachmentResults = [];
        if (attachmentUrls.length > 0) {
          console.log('\n===== ATTACHMENT PROCESSING =====');
          console.log(`Processing ${attachmentUrls.length} attachment(s)`);

          for (let i = 0; i < attachmentUrls.length; i++) {
            const attachmentUrl = attachmentUrls[i];
            console.log(
              `\n--- Processing attachment ${i + 1}/${
                attachmentUrls.length
              } ---`
            );
            console.log('Attachment URL:', attachmentUrl);

            // Check if it's a valid URL before attempting upload
            if (!isValidUrl(attachmentUrl)) {
              console.log('⚠ Attachment is not a valid URL, skipping upload');
              attachmentResults.push({
                index: i + 1,
                url: attachmentUrl,
                status: 'invalid_url',
                error: 'Invalid URL format',
              });
              continue;
            }

            console.log('✓ Valid URL detected, proceeding with upload');
            try {
              const attachmentPermanentUrl = await uploadAttachmentToAsana(
                asanaTaskId,
                attachmentUrl
              );

              if (
                attachmentPermanentUrl &&
                attachmentPermanentUrl.trim() !== ''
              ) {
                console.log(
                  '✓ Attachment uploaded successfully. Permanent URL:',
                  attachmentPermanentUrl
                );
                attachmentResults.push({
                  index: i + 1,
                  url: attachmentUrl,
                  status: 'success',
                  permanentUrl: attachmentPermanentUrl,
                });
              } else {
                console.log(
                  '✗ Attachment upload failed - no permanent URL returned'
                );
                attachmentResults.push({
                  index: i + 1,
                  url: attachmentUrl,
                  status: 'failed',
                  error: 'Upload failed - no URL returned',
                });
              }
            } catch (uploadError) {
              console.error('✗ Error during attachment upload:', uploadError);
              attachmentResults.push({
                index: i + 1,
                url: attachmentUrl,
                status: 'failed',
                error: uploadError.message || 'Upload error',
              });
            }
          }
          console.log('\n==================================');
          console.log(
            `Attachment processing complete: ${
              attachmentResults.filter((r) => r.status === 'success').length
            }/${attachmentUrls.length} successful`
          );
        } else {
          console.log('No attachments to process for this task');
        }

        // Save Asana task ID to Intercom ticket
        await updateTicketAttribute(ticketId, asanaTaskId);

        // Store mapping for webhook callbacks
        asanaTaskToConversation.set(asanaTaskId, conversationId);
        console.log(
          `Stored mapping: Asana task ${asanaTaskId} → Intercom conversation ${conversationId}`
        );

        const components = [
          {
            type: 'text',
            id: 'success',
            text: '✓ Asana Task Created',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_name',
            text: `Task: ${contactName}`,
            align: 'center',
            style: 'paragraph',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `Task ID: ${asanaTaskId}`,
            align: 'center',
            style: 'paragraph',
          },
        ];

        // Add attachment status if attachments were processed
        if (attachmentResults.length > 0) {
          const successCount = attachmentResults.filter(
            (r) => r.status === 'success'
          ).length;
          const totalCount = attachmentResults.length;
          let statusText = '';

          // Only show message if there were actual attempts
          if (totalCount > 0) {
            if (successCount === totalCount) {
              statusText = `✓ ${successCount} attachment(s) uploaded successfully`;
            } else if (successCount > 0) {
              statusText = `⚠ ${successCount}/${totalCount} attachment(s) uploaded successfully`;
            } else {
              // Only show failure message if we actually tried to upload
              const attemptedCount = attachmentResults.filter(
                (r) => r.status !== 'invalid_url'
              ).length;
              if (attemptedCount > 0) {
                statusText = `✗ Failed to upload ${totalCount} attachment(s)`;
              } else {
                statusText = `⚠ ${totalCount} attachment(s) skipped (invalid URLs)`;
              }
            }

            components.push({
              type: 'text',
              id: 'attachment_status',
              text: statusText,
              align: 'center',
              style: 'paragraph',
            });
          }
        }

        const syncedFieldsText =
          Object.keys(customFields).length > 0
            ? `✓ Synced ${
                Object.keys(customFields).length
              } custom fields to Asana`
            : '⚠ Configure ASANA_CUSTOM_FIELDS to sync custom fields';

        components.push({
          type: 'text',
          id: 'synced_fields',
          text: syncedFieldsText,
          align: 'center',
          style: 'paragraph',
        });

        const successCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        res.send(successCanvas);
      } else {
        throw new Error(
          asanaData.errors?.[0]?.message || 'Failed to create Asana task'
        );
      }
    } catch (error) {
      console.error('Error creating Asana task:', error);

      const errorCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'error',
                text: 'Error Creating Task',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'error_message',
                text: error.message || 'An unexpected error occurred',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      res.send(errorCanvas);
    }
  } else {
    res.send(initialCanvas);
  }
});

/*
  Asana webhook endpoint to receive task completion updates
  Handles the handshake and task status change events
*/
app.post('/asana-webhook-prod', async (req, res) => {
  const hookSecret = req.headers['x-hook-secret'];

  // Handle webhook handshake
  if (hookSecret) {
    console.log('===== ASANA WEBHOOK HANDSHAKE =====');
    console.log('Received webhook handshake with secret:', hookSecret);

    // Store the secret for future verification
    asanaWebhookSecret = hookSecret;

    // Respond with the secret to complete handshake
    res.set('X-Hook-Secret', hookSecret);
    res.status(200).send();

    console.log('✓ Webhook handshake completed');
    console.log('===================================\n');
    return;
  }

  // Handle webhook events
  console.log('\n===== ASANA WEBHOOK EVENT =====');
  console.log('Received webhook event');

  try {
    const events = req.body.events || [];
    console.log(`Processing ${events.length} event(s)`);

    for (const event of events) {
      console.log('\nEvent details:');
      console.log('  Action:', event.action);
      console.log('  Resource type:', event.resource?.resource_type);
      console.log('  Resource GID:', event.resource?.gid);

      // Only process task completion changes
      if (
        event.resource?.resource_type === 'task' &&
        event.action === 'changed'
      ) {
        const taskId = event.resource.gid;
        console.log('  Task changed event for task:', taskId);

        // Fetch the task to get completion status and conversation ID
        console.log('  Fetching task details from Asana...');
        const taskResponse = await fetch(
          `https://app.asana.com/api/1.0/tasks/${taskId}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${ASANA_TOKEN}`,
              Accept: 'application/json',
            },
          }
        );

        if (taskResponse.ok) {
          const taskData = await taskResponse.json();
          const isCompleted = taskData.data.completed;

          console.log('  Task completion status:', isCompleted);

          // Get conversation ID from custom fields
          let conversationId = null;
          const customFields = taskData.data.custom_fields || [];

          for (const field of customFields) {
            if (field.gid === ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID) {
              conversationId = field.text_value || field.display_value;
              console.log(
                '  Found conversation ID in custom field:',
                conversationId
              );
              break;
            }
          }

          // Fallback to in-memory map if custom field not found
          if (!conversationId) {
            conversationId = asanaTaskToConversation.get(taskId);
            if (conversationId) {
              console.log(
                '  Found conversation ID in memory map:',
                conversationId
              );
            }
          }

          if (!conversationId) {
            console.log('  ⚠ No conversation ID found for this task');
            console.log('  Skipping webhook update');
            continue;
          }

          // Get conversation to find ticket ID
          const conversation = await getConversation(conversationId);
          const ticketId = conversation?.ticket?.id;

          if (!ticketId) {
            console.log(
              '  ⚠ No ticket found for conversation:',
              conversationId
            );
            console.log('  Skipping webhook update');
            continue;
          }

          // Update Intercom ticket state ID based on completion status
          console.log(
            `  → Updating ticket_state_id (completed: ${isCompleted})`
          );
          await updateTicketStateId(ticketId, isCompleted);
        } else {
          console.error('  ✗ Failed to fetch task details');
        }
      }
    }

    console.log('================================\n');
    res.status(200).send();
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send();
  }
});

const listener = app.listen(PORT, async () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
  console.log('\n========================================');

  // Initialize custom field mappings from Asana
  await initializeCustomFieldMappings();

  console.log('========================================\n');
  console.log('✓ Server is ready to accept requests');
});
